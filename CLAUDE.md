# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

| Command | Purpose |
|---|---|
| `npm run build` | Webpack bundle into `out/main.nodejs.js` (+ `plugin.zip`) |
| `npm run fmt` / `npm run fmt:check` | Prettier — `fmt:check` is what CI runs |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run scrypted-deploy <host>` | Build and deploy to a Scrypted server (`<host>` is the Scrypted IP/hostname). The build comes from the `prescrypted-deploy` hook; the SDK's `scrypted-deploy` alone only uploads the existing `out/plugin.zip` |

There is no test suite. CI runs `fmt:check`, `lint`, and `build` only. Don't add a "run the tests" step or suggest one when none exist.

For UI/runtime testing of changes, use the `scrypted` MCP server (already configured): `reload_plugin` after a deploy, `get_logs` to read plugin output, `call_device_method` to exercise device RPCs. Logs are retained ~48h; pass `sinceMs` to focus on a recent window.

Releases publish to npm automatically when a `v*` tag is pushed. The publish workflow uses npm provenance via GitHub OIDC — don't change the publish step lightly.

The published tarball **must** contain `dist/plugin.zip` — Scrypted's `installNpm` reads `package/dist/plugin.zip` from the tarball and base64s its contents; if the file is missing, the install fails with `Cannot read properties of undefined (reading 'toString')`. `prepublishOnly` runs `NODE_ENV=production scrypted-webpack`, which writes to `dist/` (the dev build writes to `out/`). Both `out/` and `dist/` are in `.gitignore`, so we rely on the `"files": ["dist/plugin.zip"]` whitelist in `package.json` to override `.gitignore` for `npm pack`. v1.3.0 / v1.3.1 hit exactly this trap; v1.3.2 added the whitelist.

## Architecture

Single Scrypted plugin (`KasaPlugin`) that adopts two unrelated TP-Link Kasa device families behind one discovery flow.

### Two protocol families, one discovery

- **Cameras** (`src/camera/`) — three separate HTTPS endpoints per camera, all on different ports:
  - `:19443/https/stream/mixed` — receive (multipart H.264 + G.711µ); re-packetized as RTP into a local RTSP server (`spawnKasaStream`) for Scrypted to consume.
  - `:18443/https/speaker/audio/g711block` — talk (uplink chunked POST, multipart parts of 20 ms G.711µ blocks).
  - `:10443/data/LINKIE2.json` — control plane (spotlight, siren, status LED). Wire format: form-encoded `content=<base64(xor_ab(json))>`, requires `User-Agent: Kasa/...` and Basic auth.
  - Auth uses the cloud account password, but with **different encodings per endpoint**: receive = `base64(plaintext)`, talk + LINKIE2 = `md5_hex(plaintext)`. The two encodings live side by side in `src/camera/http.ts` (`kasaStreamAuth`, `kasaControlAuth`) — don't homogenize.
- **IOT devices** (`src/iot/`) — plugs/switches/dimmers/bulbs over local TCP/9999. Wire format: 4-byte BE length prefix + XOR-AB(plaintext-json). No cloud auth. Same XOR-AB cipher (`src/shared/cipher.ts`) is used for UDP/9999 discovery.
- **Discovery** (`src/shared/discovery.ts`) — single UDP/9999 sweep finds both families: a broadcast plus a paced unicast of every IP on the connected /24. Newer camera firmware drops the broadcast but answers the unicast; pacing is required to avoid kernel coalescing. Larger subnets (/23+) are skipped.

### Device class routing

`main.ts` persists a `kasaClass` storage marker (`camera | plug | switch | dimmer | bulb`) at adoption. **This marker is the source of truth for `KasaPlugin.instantiateDevice`**, not the Scrypted device type — multiple `kasaClass` values can map to the same `ScryptedDeviceType.Light` (true bulbs and dimmer plugs/switches both surface as Light). The fallback in `instantiateDevice` (legacy `dimmer=true` flag, then device-type sniff) handles devices adopted before `kasaClass` existed; preserve it.

`classifyKasa()` (in `main.ts`) only returns the four families auto-discovery can detect from sysinfo; `'dimmer'` is added later by `adoptIotDevice()` when the device exposes brightness, and the manual "Add device" dialog can persist any of the five.

Camera child devices (spotlight, siren, privacy) use suffixed nativeIds (`<camera-id>-spotlight`, `-siren`, `-privacy`). Anywhere we walk `getNativeIds()` (refresh, migrations, inventory), filter these out with `isCameraChildNativeId()` — they share the parent's sysinfo and would otherwise be re-published or double-counted. A new child type must add its suffix to `CAMERA_CHILD_SUFFIXES`.

### Stream lifecycle and cleanup (cameras)

Scrypted runs each plugin in a **worker thread**, but `child_process` and TCP servers are owned by the host Node process. Worker termination does **not** automatically reap ffmpeg / kasa HTTPS sockets / the local RTSP server. Pattern to preserve when adding any long-lived camera resource:

- Register a teardown via `registerLiveCleanup(fn)` (in `src/camera/stream.ts`) — installs a `process.on('exit')` hook on first call. Returns an unregister function; call it on normal close so the registry doesn't grow.
- Per-stream kill switch (`Deferred<void>` in `main.ts`) wires every teardown source (kasa close, RTSP client disconnect, settings change) to a single resolve. `KasaCamera.activeStreamKills` tracks them so `putSetting` (IP/port/auth changes) and `release()` can tear down stale streams — without that, the existing TCP socket keeps delivering frames from the old endpoint.
- SPS/PPS for the served SDP are scanned from the live bitstream once and **cached in per-device storage** (`cachedSps`/`cachedPps`). On reconnect we serve the cached values immediately to avoid the ~1–2 s preScanSpsPps wait that HomeKit's first-frame timeout dislikes; in-band SPS/PPS in the next IDR supersede stale values at the consumer's decoder. If you change the codec path, keep this fast-start invariant.

- **The camera accepts only one live stream (`/https/stream/mixed`) on :19443.** A second client gets a TCP connect but stalls in the TLS handshake until timeout — it is not refused, so it looks like a hang rather than an error. The limit is per live stream, not per port: `/https/stream/snapshot.jpg` on the same port works while the stream is being watched. Scrypted's prebuffer mixin owns the single connection and fans it out; never open a second `spawnKasaStream`/`KasaClient` per camera (e.g. a separate snapshot or probe stream), and when debugging, don't `curl` the stream endpoint of a camera Scrypted is already streaming — the failure you see is the limit, not a camera fault. Contrast with a dead stream server, where :19443 refuses outright while :10443 still answers; that's what the **Reboot camera** button (`smartlife.cam.ipcamera.system.set_reboot`) is for.

### Camera motion events and snapshots (opt-in)

Two per-camera settings, both off by default. Each publishes its interface only while on (`applyCameraFeatures` adds or removes it from `providedInterfaces`), so turning one off restores the previous behavior exactly.

- **Motion events from camera** → `MotionSensor`. Polls LINKIE2 `smartlife.cam.ipcamera.vod.get_detect_event_state` once a second. The firmware wants `{"timestamp": <Unix seconds>}` directly in the method object; a missing or wrong-typed one is reported as "The parameter [start_time] is required." (-40700), which is misleading. `is_moving` is true while an alarm fired within the last ~2 s (motion, person, baby cry, doorbell ring; not sound), so `motionDetected` is held for `MOTION_HOLD_MS` after the last true. There is no push or long-poll interface. Polling pauses while Privacy Mode is on and backs off on errors. The loop is guarded by `motionPollGeneration` so a stop/start during an in-flight poll can't run two loops.
- **Snapshots from camera** → `Camera`. `GET /https/stream/snapshot.jpg` on the stream port, with the stream's auth (`base64(plaintext)`). It is a fixed 640x360 JPEG; the firmware reads no size or channel query parameters. HTTP 503 means the camera is off.
- `KasaLinkieClient` keeps one kept-alive socket per camera (`maxSockets: 1`): a poll drops from ~500 ms to ~30 ms, and concurrent callers queue instead of racing. A request that fails on a reused socket the camera closed while idle is retried once. Call `destroy()` on a client that is replaced or released.
- Don't use `relay.get_preview_snapshot`: it starts an upload of a snapshot to TP-Link's cloud.
- LINKIE2 error codes: -10008 unknown module or method (doesn't prove the module exists), -40919 camera is off, -40700 / -40706 missing or invalid time parameter.

### Talk path latency

The intercom ffmpeg invocation in `KasaCamera.startIntercom` carries a deliberate set of low-latency flags (commented in-line). Without them, talkback lagged ~10 s. Two notes for editors:

- `-rtsp_transport tcp` and `-reorder_queue_size 0` are **only emitted when the input URL is RTSP** (the input args may not be — Scrypted hands ffmpeg whatever container the source uses). The conditional is intentional; ffmpeg would warn "Option not found" otherwise.
- The 20 ms / 160-byte chunking (`TALK_CHUNK_BYTES`) is the standard RTP packetization for PCMU and matches what the Kasa app sends. Don't aggregate larger blocks — the camera's uplink expects this cadence.
- The chunk queue uses a byte-counting drain rather than `Buffer.concat` per `data` event; it's O(n) over a long talk session instead of O(n²). Preserve that shape.

### IOT device polling

`KasaIotBase` (`src/iot/base.ts`), the parent of the relay devices (`KasaIotDevice`) and `KasaBulb`, drives a 30 s `refreshState` poll so external state changes (Kasa app, physical button) eventually reach Scrypted/HomeKit. The poll writes a property only when its value changed (`update()`): every assignment is an RPC and makes the server re-save the device. Per-instance jitter on the first poll spreads load when many devices boot together. `refreshInFlight` shares overlapping calls — opening parallel TCP sockets to the same plug occasionally races. The same in-flight-promise pattern is used for `emeterRealtime` (5 s cache), `KasaCamera.refreshChildDevices`, and `KasaPlugin.refreshAllDevices` — reuse it for any new operation that could be triggered concurrently.

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
