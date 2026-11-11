# TP-Link Kasa local protocols

This document describes every local network interface this plugin uses to talk to TP-Link
Kasa devices, in enough detail to write a driver in any language. Nothing here needs the
TP-Link cloud at runtime; cameras only need the Kasa account email and password, which they
check locally.

Two unrelated protocol families are covered:

| Family                                                               | Devices                              | Transport                     | Auth                     |
| -------------------------------------------------------------------- | ------------------------------------ | ----------------------------- | ------------------------ |
| [Smart home (IOT)](#smart-home-devices-plugs-switches-dimmers-bulbs) | plugs, wall switches, dimmers, bulbs | TCP 9999, XOR-obfuscated JSON | none                     |
| [Cameras](#cameras)                                                  | indoor/outdoor cameras, doorbells    | HTTPS on 19443, 18443, 10443  | Kasa account, HTTP Basic |

Both families answer the same [UDP discovery](#discovery-udp-9999) probe.

The devices this has been used with are listed under [Tested devices](#tested-devices).

## Contents

- [XOR autokey cipher](#xor-autokey-cipher)
- [Discovery (UDP 9999)](#discovery-udp-9999)
- [Smart home devices (plugs, switches, dimmers, bulbs)](#smart-home-devices-plugs-switches-dimmers-bulbs)
- [Cameras](#cameras)
    - [Authentication](#camera-authentication)
    - [Live stream](#live-stream-get-httpsstreammixed)
    - [Snapshot](#snapshot-get-httpsstreamsnapshotjpg)
    - [Audio-only stream](#audio-only-stream-get-httpsstreamaudiowavpcm)
    - [Talk (two-way audio)](#talk-post-httpsspeakeraudiog711block)
    - [LINKIE2 control API](#linkie2-control-api-post-datalinkie2json)
- [Tested devices](#tested-devices)
- [References](#references)

## XOR autokey cipher

Discovery, the smart home protocol and the camera control API all obfuscate their JSON with
the same byte-wise XOR "autokey" scheme. It is not encryption in any meaningful sense, just a
fixed transform.

- The key starts at `0xAB` (171).
- Each output **ciphertext** byte becomes the key for the next byte, in both directions.

```
encrypt(plain):              decrypt(cipher):
  key = 0xAB                   key = 0xAB
  for each byte p:             for each byte c:
    c = key XOR p                p = key XOR c
    emit c                       emit p
    key = c                      key = c
```

Test vector: `{"system":{"get_sysinfo":{}}}` (29 bytes, UTF-8) encrypts to

```
d0f281f88bff9af7d5ef94b6d1b4c09fec95e68fe187e8caf08bf68bf6
```

## Discovery (UDP 9999)

Send the encrypted `{"system":{"get_sysinfo":{}}}` (exactly the test vector above, no length
prefix) as a UDP datagram to port 9999. Every Kasa device on the network replies from port
9999 with one datagram: the encrypted JSON of its system info.

Addressing:

- Broadcast to `255.255.255.255` and to each interface's subnet broadcast address.
- Some cameras (e.g. KC420WS) **ignore broadcast** but answers a unicast probe.
  To find those, also send the probe to every host address in the local subnet. Pace the
  unicast sends (the plugin waits 3 ms between them); a back-to-back burst of 254 datagrams
  gets dropped and cameras are missed.
- Listen on the same socket for about 2.5 s. Replies arrive from the device's IP, which is
  the address to use for everything else.

### Reply

Smart home devices answer in the usual envelope:

```json
{
    "system": {
        "get_sysinfo": {
            "alias": "Garage Lights",
            "model": "EP25(US)",
            "deviceId": "8006…",
            "mac": "54:AF:97:2D:AA:24",
            "type": "IOT.SMARTPLUGSWITCH",
            "hw_ver": "1.0",
            "relay_state": 0,
            "feature": "TIM:ENE",
            "dev_name": "Smart Wi-Fi Plug Mini",
            "err_code": 0
        }
    }
}
```

Cameras answer with a differently shaped object. Their identifying fields sit at a different
depth and use different names (`mic_mac` and `mic_type` instead of `mac` and `type`). A robust
parser walks the JSON tree a few levels deep and takes the object that has the most of
`model`, `alias`, `deviceId`/`dev_id`, `mac`/`mic_mac` and `type`/`mic_type`.

Fields used:

| Field                                               | Meaning                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `deviceId` (or `dev_id`)                            | Stable 40-hex-character device ID. Use it as the device's identity and serial number. |
| `alias`                                             | Name set in the Kasa app.                                                             |
| `model`                                             | Model string, e.g. `KC410S(US)`.                                                      |
| `mac` / `mic_mac`                                   | MAC address. Formatting varies (`54:AF:…` or `503DD1D278D4`).                         |
| `type` / `mic_type`                                 | Device family, see below.                                                             |
| `sw_ver`                                            | Software version.                                                                     |
| `hw_ver`                                            | Hardware revision, e.g. `1.0`.                                                        |
| `dev_name`                                          | Product description; tells switches and dimmers apart from plugs.                     |
| `feature`                                           | Capability string; contains `ENE` for energy monitoring, `DIM` on some dimmers.       |
| `brightness`                                        | Present on dimmers.                                                                   |
| `is_color`, `is_variable_color_temp`, `is_dimmable` | Bulb capabilities, `1` = supported.                                                   |
| `children`                                          | Present (non-empty) on multi-outlet strips.                                           |
| `relay_state`                                       | Plugs and switches: `1` on, `0` off.                                                  |
| `light_state`                                       | Bulbs: current light state, see [bulbs](#bulbs).                                      |

### Classifying a device

| `type`                                                                            | Class                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `IOT.IPCAMERA`                                                                    | camera                                                          |
| `IOT.SMARTBULB`                                                                   | bulb                                                            |
| `IOT.SMARTPLUGSWITCH` with non-empty `children`                                   | multi-outlet strip (HS300, KP303; not supported by this plugin) |
| `IOT.SMARTPLUGSWITCH`, `dev_name` matches `switch` or `dimmer` (case-insensitive) | wall switch                                                     |
| `IOT.SMARTPLUGSWITCH`, otherwise                                                  | plug                                                            |

A plug or switch is a **dimmer** when any of these holds: `brightness` is a number, `feature`
contains `DIM`, or `dev_name` contains `dimmer`. The last check is needed for the KS230
3-way dimmer, which reports neither of the first two while idle.

## Smart home devices (plugs, switches, dimmers, bulbs)

### Transport

- TCP connection to port 9999 of the device. No TLS, no authentication.
- Request: a 4-byte **big-endian** length of the JSON, followed by the encrypted JSON. The
  length counts the plaintext bytes, which equals the ciphertext length.
- Response: the same framing. Read 4 bytes, then exactly that many bytes, then decrypt. Large
  replies (bulb state) arrive split over several TCP segments; keep reading until the full
  length is in.
- One request per connection works; the plugin opens a new connection per command and
  closes it after the reply. It uses a 5 s timeout.
- Don't send concurrent requests to one device: parallel connections occasionally race and
  lose a reply.

Framed test vector for `{"system":{"get_sysinfo":{}}}`:

```
0000001d d0f281f88bff9af7d5ef94b6d1b4c09fec95e68fe187e8caf08bf68bf6
```

### Envelope

Requests are `{"<module>":{"<method>":{<arguments>}}}`. Several modules or methods can go in
one request. The reply mirrors the request's structure, with each method's result in place
of its arguments. Every result carries `err_code`, `0` meaning success.

```json
request:  {"system":{"set_relay_state":{"state":1}}}
response: {"system":{"set_relay_state":{"err_code":0}}}
```

### Commands

| Purpose                                          | Request                                                                      | Result                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Read state                                       | `{"system":{"get_sysinfo":{}}}`                                              | system info, as in discovery                                        |
| Relay on/off (plugs, switches, dimmers)          | `{"system":{"set_relay_state":{"state":1}}}` (`0` = off)                     | `err_code`                                                          |
| Dimmer brightness                                | `{"smartlife.iot.dimmer":{"set_brightness":{"brightness":N}}}`, N = 1–100    | `err_code`                                                          |
| Energy reading (devices with `ENE` in `feature`) | `{"emeter":{"get_realtime":{}}}`                                             | see below                                                           |
| Daily energy totals for one month                | `{"emeter":{"get_daystat":{"year":2026,"month":11}}}`                        | see below                                                           |
| Monthly energy totals for one year               | `{"emeter":{"get_monthstat":{"year":2026}}}`                                 | see below                                                           |
| Device clock                                     | `{"time":{"get_time":{}}}`                                                   | `{"year","month","mday","hour","min","sec","err_code"}`, local time |
| Bulb state change                                | `{"smartlife.iot.smartbulb.lightingservice":{"transition_light_state":{…}}}` | new light state                                                     |

For plugs, switches and dimmers, poll `get_sysinfo` for state: `relay_state` (`1` on) and,
on dimmers, `brightness`. Nothing is pushed; the plugin polls every 30 s to pick up changes
made in the Kasa app or with the physical button.

### Energy monitoring

`emeter.get_realtime` returns one of two schemas depending on the device:

| Milli-units       | Base units    |
| ----------------- | ------------- |
| `voltage_mv` (mV) | `voltage` (V) |
| `current_ma` (mA) | `current` (A) |
| `power_mw` (mW)   | `power` (W)   |
| `total_wh` (Wh)   | `total` (kWh) |

Check which keys are present rather than relying on the model. A non-zero `err_code` means no
reading.

The plug also keeps its own usage history, which is what the Kasa app's charts show:

```json
{"emeter":{"get_daystat":{"day_list":[
  {"year":2026,"month":11,"day":9,"energy_wh":21},
  {"year":2026,"month":11,"day":10,"energy_wh":4}],"err_code":0}}}

{"emeter":{"get_monthstat":{"month_list":[
  {"year":2026,"month":7,"energy_wh":1052},
  {"year":2026,"month":11,"energy_wh":118}],"err_code":0}}}
```

- Both `year` and `month` are required for `get_daystat`; without them it answers `err_code`
  `-3` "invalid argument".
- Days and months without usage are left out of the lists; treat a missing entry as 0.
- Devices that use the base-unit schema report `energy` in kWh instead of `energy_wh`.
- Dates are the plug's local dates. Take "today" from `time.get_time` rather than from the
  client's clock, which may be in another time zone.
- Several methods of one module can go in one request, e.g.
  `{"emeter":{"get_daystat":{…},"get_monthstat":{…}}}`, and the reply carries both. A
  method can only appear once per request, so two months of daily totals take two requests.

### Bulbs

All bulb changes go through one method, with only the fields to change:

```json
{
    "smartlife.iot.smartbulb.lightingservice": {
        "transition_light_state": {
            "ignore_default": 1,
            "on_off": 1,
            "brightness": 80,
            "hue": 120,
            "saturation": 100,
            "color_temp": 2700
        }
    }
}
```

| Field               | Meaning                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore_default`    | `1`: merge with the current state instead of resetting the other fields. Always send it.                                                                                                |
| `on_off`            | `1` on, `0` off.                                                                                                                                                                        |
| `brightness`        | 0–100.                                                                                                                                                                                  |
| `hue`, `saturation` | 0–360, 0–100. Color bulbs only (`is_color` = 1).                                                                                                                                        |
| `color_temp`        | Kelvin, color-temperature bulbs only (`is_variable_color_temp` = 1). Send `0` together with `hue`/`saturation` to switch the bulb to color mode; some bulbs ignore the color otherwise. |

State comes from `light_state` in `get_sysinfo`. While the bulb is **off**, `light_state` has
only `on_off: 0` and the remembered values are nested under `light_state.dft_on_state`:

```json
on:  {"on_off":1,"brightness":80,"hue":0,"saturation":0,"color_temp":2700,…}
off: {"on_off":0,"dft_on_state":{"brightness":80,"hue":0,"saturation":0,"color_temp":2700,…}}
```

The color temperature range is per model and not reported by this command; the plugin
assumes 2700–6500 K.

## Cameras

A camera serves three HTTPS endpoints, each on its own port:

| Port  | Path                             | Purpose                                             | Password encoding |
| ----- | -------------------------------- | --------------------------------------------------- | ----------------- |
| 19443 | `/https/stream/mixed`            | live H.264 + G.711 stream                           | base64            |
| 19443 | `/https/stream/snapshot.jpg`     | JPEG snapshot                                       | base64            |
| 19443 | `/https/stream/audio/wavpcm`     | audio-only stream                                   | base64            |
| 18443 | `/https/speaker/audio/g711block` | talk to the camera's speaker                        | MD5               |
| 10443 | `/data/LINKIE2.json`             | control API (LED, spotlight, siren, PTZ, motion, …) | MD5               |

Common to all of them:

- TLS with a **self-signed certificate**. There is nothing to validate it against, so
  certificate verification has to be turned off.
- Authentication is HTTP Basic. Send it on the **first** request: don't rely on a `401`
  challenge, since LINKIE2 silently drops a request without valid credentials.

### Camera authentication

The username is the Kasa account email. The password part of the Basic credentials is an
**encoded form** of the account password, and the encoding differs per endpoint. Each
endpoint rejects the other's encoding.

| Endpoints                            | Password field                |
| ------------------------------------ | ----------------------------- |
| stream, snapshot, audio-only (19443) | `base64(password)`            |
| talk (18443), LINKIE2 (10443)        | lowercase hex `md5(password)` |

```
stream:  Authorization: Basic base64( email + ":" + base64(password) )
control: Authorization: Basic base64( email + ":" + hex(md5(password)) )
```

Example for `user@example.com` / `secret`:

```
stream:  Basic dXNlckBleGFtcGxlLmNvbTpjMlZqY21WMA==
control: Basic dXNlckBleGFtcGxlLmNvbTo1ZWJlMjI5NGVjZDBlMGYwOGVhYjc2OTBkMmE2ZWU2OQ==
```

The audio-only endpoint answers a request without credentials with `401 Unauthorized` and
`WWW-Authenticate: Basic realm="smarthome@tp-link.com"`.

### Live stream: `GET /https/stream/mixed`

```
GET /https/stream/mixed HTTP/1.1
Host: <camera>:19443
Authorization: Basic <stream credentials>
Accept: */*
Connection: keep-alive
```

The response never ends; the body is the live stream as
`multipart/x-mixed-replace;boundary=<boundary>`. Take the boundary from the `Content-Type`
response header. Each part is:

```
--<boundary>\r\n
Content-Type: video/x-h264\r\n
Content-Length: 12345\r\n
\r\n
<12345 bytes of payload>
```

| Part `Content-Type` | Payload                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `video/x-h264`      | H.264 in Annex B format (NAL units with `00 00 01` / `00 00 00 01` start codes). SPS (NAL type 7) and PPS (type 8) arrive in-band before key frames. |
| `audio/g711u`       | G.711 µ-law, 8 kHz, mono.                                                                                                                            |

Parsing notes:

- Use `Content-Length` to read the payload; don't search for the next boundary.
- Tolerate blank lines before a boundary line and LF-only line endings; header names may
  vary in case.
- Parts carry no timestamps. Timestamp each part when it arrives: video and audio are
  interleaved in real time. For audio, advance the timestamp by the sample count (1 byte =
  1 sample at 8 kHz) rather than by arrival time, to avoid audible jitter.
- To build an SDP or decoder config up front, scan the first video parts for SPS and PPS.
  Caching them per camera lets a later connection start without that wait; the in-band
  copies before each key frame take over anyway.
- Typical video (KC410S, KD110, KC420WS): 1920x1080, H.264 Main profile, 15 fps. The SPS has no bitstream restriction block, so decoders may not assume
  "no frame reordering" (some ffmpeg muxers warn about unset timestamps as a result).

Limits and failure modes:

- **One live stream per camera.** A second connection to `/https/stream/mixed` while one is
  open completes the TCP connect and then **stalls in the TLS handshake** until it times out.
  It is not refused, so it looks like a hang. Fan one connection out to all consumers. The
  limit applies to this path only: snapshots and the audio-only stream work alongside it.
- **Camera turned off** (Privacy Mode, "camera off" in the Kasa app): the port stays open and
  the request is answered with **HTTP 503**. The next request after the camera is turned back
  on succeeds.
- **Dead stream server:** some cameras occasionally stop serving 19443 (connection refused)
  while 10443 still answers. Only a reboot fixes it; see
  [`system.set_reboot`](#linkie2-methods).
- The stream can go quiet for a few seconds on weak Wi-Fi and then resume. Don't use a short
  read timeout once the response headers are in; use TCP keepalive to detect a dead
  connection instead.

### Snapshot: `GET /https/stream/snapshot.jpg`

```
GET /https/stream/snapshot.jpg HTTP/1.1
Authorization: Basic <stream credentials>
Accept: image/*
```

- Returns a single JPEG of about 60–110 KB. The `Content-Type` header says `image/jpg`; check
  for the JPEG start marker `FF D8` rather than trusting the header.
- Always 640x360. The camera reads no query parameters (size, quality, channel); for full
  resolution, take a frame from the live stream.
- Works while the live stream is open.
- **HTTP 503** while the camera is turned off.
- A normal answer takes about 0.5 s. Cameras on a weak link sometimes take several seconds or
  fail; callers that need an answer quickly should keep the last good image.
- The server keeps the connection alive. If the camera closed an idle kept-alive connection,
  the next request on it fails with a reset; retry once on a new connection.

### Audio-only stream: `GET /https/stream/audio/wavpcm`

Not used by the plugin.

```
GET /https/stream/audio/wavpcm HTTP/1.1
Authorization: Basic <stream credentials>
```

Response headers:

```
HTTP/1.1 200 OK
Server: umedia-servie,pcm
Content-Type: audio/x-wav
Content-Length: 115200000
Connection: close
```

- The body is a WAV file streamed live: a standard 44-byte RIFF/WAVE header declaring
  16-bit signed little-endian PCM, mono, 8000 Hz (16000 bytes per second), followed by live
  microphone samples.
- The declared length, 115,200,000 bytes, is 2 hours of audio; expect the camera to end the
  response then and reconnect.
- Works alongside an open live stream without disturbing it.
- `401 Unauthorized` with a Basic challenge without valid credentials.

### Talk: `POST /https/speaker/audio/g711block`

Plays audio on the camera's speaker. One long-lived request per talk session:

```
POST /https/speaker/audio/g711block?playerId=<player id> HTTP/1.1
Host: <camera>:18443
Authorization: Basic <control credentials>
X-APP-ID: <player id>
Content-Type: multipart/x-mixed-replace;boundary=audio-boundary--
Transfer-Encoding: chunked
Connection: keep-alive
Accept: */*
```

- `<player id>` is `tty.` followed by 32 random alphanumeric characters. It is generated by
  the client, not negotiated; use a new one per session and send it in both places.
- The body is chunked and stays open for the whole session. Each audio part is:

    ```
    --audio-boundary--\r\n
    Content-Length: 160\r\n
    Content-Type: audio/g711u\r\n
    \r\n
    <160 bytes of G.711 µ-law>\r\n
    ```

- Audio is G.711 µ-law, 8 kHz, mono, in **20 ms blocks of 160 bytes**, sent in real time.
  This matches the Kasa app; don't aggregate larger blocks. Send each part (header, payload
  and trailing CRLF) as one write, so it arrives as one chunk.
- Send an empty heartbeat part when the session starts and every 3 s, so the camera keeps the
  connection during silence:

    ```
    --audio-boundary--\r\n
    Content-Length: 0\r\n
    Content-Type: audio/heartbeat\r\n
    \r\n
    \r\n
    ```

- End the session by ending the request body. The camera may also end it on its own (it
  sends a response and closes); stop sending when that happens.
- Disable Nagle's algorithm on the socket; small parts otherwise get delayed and the audio
  turns choppy.

### LINKIE2 control API: `POST /data/LINKIE2.json`

Everything that isn't audio or video: status LED, spotlight, siren, camera on/off, pan/tilt,
motion state, reboot.

#### Request

```
POST /data/LINKIE2.json HTTP/1.1
Host: <camera>:10443
Authorization: Basic <control credentials>
Content-Type: application/x-www-form-urlencoded; charset=utf-8
User-Agent: Kasa/1752 CFNetwork/3860.500.112 Darwin/25.4.0
Accept: */*
Accept-Encoding: identity
Connection: keep-alive

content=<url-encoded base64( xor_encrypt( json ) )>
```

- The `User-Agent` must look like the Kasa app (start with `Kasa/`). Requests that don't are
  **silently dropped**: no response at all.
- Send `Authorization` on the first request; there is no `401` challenge.
- `Accept-Encoding: identity` keeps the camera from compressing the reply, which would
  break the decoding below.
- The JSON uses the same module/method envelope as the smart home protocol, with modules under
  `smartlife.cam.ipcamera.`. The Kasa app adds a `context` object with a random UUID; the
  camera ignores it, but the plugin sends it too:

    ```json
    { "smartlife.cam.ipcamera.led": { "get_status": {} }, "context": { "source": "<uuid>" } }
    ```

Test vector, without `context`: `{"smartlife.cam.ipcamera.led":{"get_status":{}}}` becomes

```
content=0PKB7I3%2Fi%2BeO6I2jwKHM4ov7mPmU8YPizKDFoYO5wuCH4pbJus6v267d%2F8W%2Bw77D
```

#### Response

The body is `base64( xor_encrypt( json ) )`: trim whitespace, base64-decode, XOR-decrypt,
parse. The reply mirrors the request, and each method's result has an `err_code`:

```json
{ "smartlife.cam.ipcamera.led": { "get_status": { "value": "on", "err_code": 0 } } }
```

An HTTP status of 400 or higher is a transport-level failure.

#### Connection handling

- Keep one connection per camera alive and reuse it. A call on a fresh TLS connection takes
  about 500 ms, and on a kept-alive one about 30 ms.
- **Serialize calls to one camera.** Parallel requests to the same camera occasionally lose a
  reply. The Kasa app also issues them one at a time.
- A request on a kept-alive connection the camera closed while idle fails with a reset;
  retry it once on a new connection.
- Typical timeout: 5 s.

#### LINKIE2 methods

All module names below are relative to `smartlife.cam.ipcamera.`, so `led` means
`smartlife.cam.ipcamera.led`.

On/off features share one shape: reading returns `{"value":"on"|"off","err_code":0}`, and
setting takes `{"value":"on"|"off"}` and returns `{"err_code":0}`. A camera that lacks the
feature answers with an error code or leaves the module out of the reply, so a successful read
doubles as feature detection.

| Feature       | Module     | Read                   | Write                  | Notes                                                                                                                                 |
| ------------- | ---------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Status LED    | `led`      | `get_status`           | `set_status`           |                                                                                                                                       |
| Spotlight     | `dayNight` | `get_force_lamp_state` | `set_force_lamp_state` | Called "spotlight" in the app (KC420WS).                                                                                              |
| Siren         | `siren`    | `get_state`            | `set_state`            | The camera stops the siren by itself after the duration set in the app (default 30 s), so a read shortly after may already say `off`. |
| Camera on/off | `switch`   | `get_is_enable`        | `set_is_enable`        | `off` is "camera off" / privacy: video stops for every client, the stream answers HTTP 503 and other calls may return `-40919`.       |

Other methods:

| Purpose             | Module / method                  | Arguments                                                      | Result                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reboot              | `system` / `set_reboot`          | `{}`                                                           | `err_code`. The camera drops off the network after about 20 s and is back with all ports open after about 30 s. (`system.reboot` does not exist and returns `-10008`.)                                                                                                                                              |
| Pan/tilt capability | `ptz` / `get_capability`         | `{}`                                                           | `{"err_code":0,"max_x":N,"max_y":N}`. Fixed-lens models return `-10008`; use it to detect pan/tilt support.                                                                                                                                                                                                         |
| Saved viewpoints    | `ptz` / `get_all_preset`         | `{}`                                                           | `{"err_code":0,"preset_attr":[…]}`. The entry shape isn't documented; the plugin reads `index` and `name` when present and otherwise uses the 1-based position.                                                                                                                                                     |
| Move one step       | `ptz` / `set_move`               | `{"direction":"left"\|"right"\|"top"\|"bottom","speed":1..10}` | `err_code`. Lowercase, and `top`/`bottom`, not `up`/`down`. `speed` is the step size, not a rate: each call moves one discrete step (1 ≈ 50 units, 10 ≈ 333 units on the tilt axis) and stops. `-41203` for a bad argument or an axis already at its end stop. There is no absolute position, home or zoom command. |
| Go to viewpoint     | `ptz` / `set_run_to_preset`      | `{"index":n}` (1-based)                                        | `err_code`                                                                                                                                                                                                                                                                                                          |
| Motion state        | `vod` / `get_detect_event_state` | `{"timestamp":<Unix seconds>}`                                 | `{"err_code":0,"is_moving":true\|false,…}`                                                                                                                                                                                                                                                                          |

Motion details:

- `is_moving` is `true` while an alarm fired within the last ~2 s: motion, person detection,
  baby cry, or a doorbell press. Sound alarms are not included.
- There is no push or long-poll interface; poll it. The plugin polls once a second and holds
  "motion" for 10 s after the last `true`, since `is_moving` flickers while a person stands
  still.
- `timestamp` is required and must be a number of Unix seconds (after 2019-05-01). A missing
  or wrongly typed one is reported as `-40700` "The parameter [start_time] is required.",
  which is misleading. The value only affects SD-card recording flags in the reply
  (`is_video_ready`, `is_event_finish`).
- Occasionally the reply has no `err_code` at all, or `-40709` "Other error.", and the next
  poll succeeds. Treat both as a transient failure.
- Doorbell presses (KD110) are reported only through `is_moving`; there is no separate ring event.

#### LINKIE2 error codes

| Code               | Meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `0`                | Success.                                                                                      |
| `-10008`           | "Unsupported API call." Unknown module or unknown method. It doesn't prove the module exists. |
| `-40919`           | The camera is turned off.                                                                     |
| `-40700`, `-40706` | Missing or invalid time parameter (see motion).                                               |
| `-40709`           | "Other error." Returned sporadically by `vod.get_detect_event_state`; transient.              |
| `-41203`           | Invalid PTZ argument, or the axis is at its end stop.                                         |

The codes are the same on KC410S, KC420WS and KD110.

#### Do not use

`relay.get_preview_snapshot` starts an upload of a snapshot to TP-Link's cloud. Use the local
[snapshot](#snapshot-get-httpsstreamsnapshotjpg) instead.

## Tested devices

| Device                        | Model              | What is used                                                                           |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| Pan/tilt camera               | KC410S(US)         | stream, snapshot, audio-only stream, talk, LED, siren, camera on/off, pan/tilt, motion |
| Outdoor camera with spotlight | KC420WS            | stream, snapshot, talk, LED, spotlight, siren, camera on/off, motion                   |
| Video doorbell                | KD110              | stream, snapshot, motion (including doorbell press as motion)                          |
| Other cameras                 | KC200, KC401, EC71 | stream and talk                                                                        |
| Energy-monitoring plug        | EP25(US)           | relay, energy monitoring, discovery                                                    |
| 3-way dimmer switch           | KS230              | relay, brightness, dimmer detection by `dev_name`                                      |

## References

- [go2rtc `pkg/kasa`](https://github.com/AlexxIT/go2rtc/tree/master/pkg/kasa): the camera
  stream format.
- The smart home protocol is the widely documented legacy TP-Link "smarthome" format, also
  implemented by [python-kasa](https://github.com/python-kasa/python-kasa).
- Source in this repository: `src/shared/cipher.ts`, `src/shared/discovery.ts`,
  `src/iot/`, `src/camera/api.ts`, `src/camera/intercom.ts`, `src/camera/linkie.ts`,
  `src/camera/http.ts`.
