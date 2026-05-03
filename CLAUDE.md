# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

| Command | Purpose |
|---|---|
| `npm run build` | Webpack bundle into `out/main.nodejs.js` (+ `plugin.zip`) |
| `npm run fmt` / `npm run fmt:check` | Prettier — `fmt:check` is what CI runs |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run scrypted-deploy <host>` | Build and deploy to a Scrypted server (`<host>` is the Scrypted IP/hostname) |

There is no test suite. CI runs `fmt:check`, `lint`, and `build` only. Don't add a "run the tests" step or suggest one when none exist.

For UI/runtime testing of changes, use the `scrypted` MCP server (already configured): `reload_plugin` after a deploy, `get_logs` to read plugin output, `call_device_method` to exercise device RPCs. Logs are retained ~48h; pass `sinceMs` to focus on a recent window.

Releases publish to npm automatically when a `v*` tag is pushed. The publish workflow uses npm provenance via GitHub OIDC — don't change the publish step lightly.

## Architecture

Single Scrypted plugin (`KasaPlugin`) that adopts two unrelated TP-Link Kasa device families behind one discovery flow.

### Two protocol families, one discovery

- **Cameras** (`src/camera/`) — three separate HTTPS endpoints per camera, all on different ports:
  - `:19443/https/stream/mixed` — receive (multipart H.264 + G.711µ); re-packetized as RTP into a local RTSP server (`spawnKasaStream`) for Scrypted to consume.
  - `:18443/https/speaker/audio/g711block` — talk (uplink chunked POST, multipart parts of 20 ms G.711µ blocks).
  - `:10443/data/LINKIE2.json` — control plane (spotlight, siren, status LED). Wire format: form-encoded `content=<base64(xor_ab(json))>`, requires `User-Agent: Kasa/...` and Basic auth.
  - Auth uses the cloud account password, but with **different encodings per endpoint**: receive = `base64(plaintext)`, talk + LINKIE2 = `md5_hex(plaintext)`. `KasaClient` / `KasaTalkSession` / `KasaLinkieClient` each apply the right one — don't homogenize.
- **IOT devices** (`src/iot/`) — plugs/switches/dimmers/bulbs over local TCP/9999. Wire format: 4-byte BE length prefix + XOR-AB(plaintext-json). No cloud auth. Same XOR-AB cipher (`src/shared/cipher.ts`) is used for UDP/9999 discovery.
- **Discovery** (`src/shared/discovery.ts`) — single UDP/9999 sweep finds both families: a broadcast plus a paced unicast of every IP on the connected /24. Newer camera firmware drops the broadcast but answers the unicast; pacing is required to avoid kernel coalescing. Larger subnets (/23+) are skipped.

### Device class routing

`main.ts` persists a `kasaClass` storage marker (`camera | plug | switch | dimmer | bulb`) at adoption. **This marker is the source of truth for `KasaPlugin.instantiateDevice`**, not the Scrypted device type — multiple `kasaClass` values can map to the same `ScryptedDeviceType.Light` (true bulbs and dimmer plugs/switches both surface as Light). The fallback in `instantiateDevice` (legacy `dimmer=true` flag, then device-type sniff) handles devices adopted before `kasaClass` existed; preserve it.

`classifyKasa()` (in `main.ts`) only returns the four families auto-discovery can detect from sysinfo; `'dimmer'` is added later by `adoptIotDevice()` when the device exposes brightness, and the manual "Add device" dialog can persist any of the five.

Camera child devices (spotlight, siren) use suffixed nativeIds (`<camera-id>-spotlight`, `-siren`). Anywhere we walk `getNativeIds()` (refresh, migrations, inventory), filter these out — they share the parent's sysinfo and would otherwise be re-published or double-counted.

### Stream lifecycle and cleanup (cameras)

Scrypted runs each plugin in a **worker thread**, but `child_process` and TCP servers are owned by the host Node process. Worker termination does **not** automatically reap ffmpeg / kasa HTTPS sockets / the local RTSP server. Pattern to preserve when adding any long-lived camera resource:

- Register a teardown via `registerLiveCleanup(fn)` (in `src/camera/stream.ts`) — installs a `process.on('exit')` hook on first call. Returns an unregister function; call it on normal close so the registry doesn't grow.
- Per-stream kill switch (`Deferred<void>` in `main.ts`) wires every teardown source (kasa close, RTSP client disconnect, settings change) to a single resolve. `KasaCamera.activeStreamKills` tracks them so `putSetting` (IP/port/auth changes) and `release()` can tear down stale streams — without that, the existing TCP socket keeps delivering frames from the old endpoint.
- SPS/PPS for the served SDP are scanned from the live bitstream once and **cached in per-device storage** (`cachedSps`/`cachedPps`). On reconnect we serve the cached values immediately to avoid the ~1–2 s preScanSpsPps wait that HomeKit's first-frame timeout dislikes; in-band SPS/PPS in the next IDR supersede stale values at the consumer's decoder. If you change the codec path, keep this fast-start invariant.

### Talk path latency

The intercom ffmpeg invocation in `KasaCamera.startIntercom` carries a deliberate set of low-latency flags (commented in-line). Without them, talkback lagged ~10 s. Two notes for editors:

- `-rtsp_transport tcp` and `-reorder_queue_size 0` are **only emitted when the input URL is RTSP** (the input args may not be — Scrypted hands ffmpeg whatever container the source uses). The conditional is intentional; ffmpeg would warn "Option not found" otherwise.
- The 20 ms / 160-byte chunking (`TALK_CHUNK_BYTES`) is the standard RTP packetization for PCMU and matches what the Kasa app sends. Don't aggregate larger blocks — the camera's uplink expects this cadence.
- The chunk queue uses a byte-counting drain rather than `Buffer.concat` per `data` event; it's O(n) over a long talk session instead of O(n²). Preserve that shape.

### IOT device polling

`KasaIotDevice` drives a 30 s `refreshState` poll (`src/iot/device.ts`) so external state changes (Kasa app, physical button) eventually reach Scrypted/HomeKit. Per-instance jitter on the first poll spreads load when many devices boot together. `refreshInFlight` shares overlapping calls — opening parallel TCP sockets to the same plug occasionally races. The same in-flight-promise pattern is used for `emeterRealtime` (5 s cache), `KasaCamera.refreshChildDevices`, and `KasaPlugin.refreshAllDevices` — reuse it for any new operation that could be triggered concurrently.

`device.release()` (called from `KasaPlugin.releaseDevice`) clears the poll timers — keep new background timers off the device unless `release()` learns to clear them, otherwise removing a device leaks intervals.

### `onDeviceDiscovered` and interfaces

When re-publishing an existing device (refresh, migration), pass `state.providedInterfaces`, **not** `state.interfaces`. The latter includes mixin-provided interfaces (HomeKit, NVR, etc.) which we'd incorrectly re-claim ownership of. `migrateAddReadme` does this correctly — copy that pattern.

Empty-string `room` clears an existing room assignment in `onDeviceDiscovered`; pass `undefined` to leave it alone.

## Conventions

- `any` is allowed for Kasa sysinfo (the JSON shape varies per device family) and narrow runtime-tag casts (`kasaClass`). The ESLint config disables `@typescript-eslint/no-explicit-any` deliberately.
- Empty `catch {}` blocks are a deliberate teardown idiom (`try { socket.close(); } catch {}`) — `no-empty` is configured to allow them.
- `_`-prefixed args/vars are intentionally unused.
- Comments in this codebase explain *why* (hidden constraints, protocol quirks, prior incidents). Don't strip them. New comments should follow the same bar — a load-bearing reason, not a description of what the next line does.
- Commits: use `Assisted-by:` trailer (not `Co-Authored-By:`) and always sign off with `git commit -s`.
