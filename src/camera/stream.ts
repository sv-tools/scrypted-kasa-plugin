import net from 'net';
import { findSpsPps, KasaClient, KasaMimeG711U, KasaMimeVideo, KasaPart } from './api';
import { G711_CLOCK_HZ, G711RtpPacketizer, H264_CLOCK_HZ, H264RtpPacketizer, nowNtp } from './rtp';
import { handleRtspClient, RTSP_INTERLEAVED_HEADER_LEN } from './rtsp';

// Process-level cleanup registry. Scrypted runs plugins as worker threads; resources
// owned by the host Node process (TCP servers, kasa HTTPS connections) survive worker
// termination otherwise. Every spawnKasaStream registers its kill function and removes
// itself on normal teardown. On worker exit, the hook nukes anything still live.
const liveCleanups = new Set<() => void>();
let exitHookInstalled = false;
function installExitHook() {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once('exit', () => {
        for (const cleanup of liveCleanups) {
            try {
                cleanup();
            } catch {
                /* best-effort, can't do anything from inside 'exit' */
            }
        }
        liveCleanups.clear();
    });
}

export function registerLiveCleanup(cleanup: () => void): () => void {
    installExitHook();
    liveCleanups.add(cleanup);
    return () => liveCleanups.delete(cleanup);
}

// Hard ceiling on the upfront SPS/PPS scan. Real cameras emit them well under a second; if
// we don't see them in this window the camera is misbehaving and there's no point holding
// the call.
const SPS_PPS_TIMEOUT_MS = 10000;

export interface KasaStreamOptions {
    kasa: KasaClient;
    console: Console;
    // Optional cached SPS/PPS from a previous session. When present we skip the
    // preScanSpsPps wait (which holds getVideoStream up to ~2s on KC420WS waiting for the
    // next IDR) and start streaming live parts immediately. Cached values come from this
    // camera's own previous bitstream so they're correct unless the encoder profile
    // changed (resolution / bitrate setting); even when stale, the in-band SPS/PPS that
    // arrive with the next IDR will replace them at the consumer's decoder.
    cachedSps?: Buffer;
    cachedPps?: Buffer;
    // Called when we successfully scanned fresh SPS/PPS from the live bitstream. The
    // caller persists these so subsequent sessions can use the cached path.
    onFreshSpsPps?: (sps: Buffer, pps: Buffer) => void;
}

export interface KasaStreamHandle {
    url: string;
    kill(): void;
    exited: Promise<void>;
}

// Build the SDP we serve on DESCRIBE. We embed sprop-parameter-sets so consumers can decode
// without waiting for the next IDR — important for HomeKit's strict first-frame timeouts.
function buildSdp(sps: Buffer, pps: Buffer): string {
    // RFC 6184: profile-level-id is the 3 SPS bytes (profile_idc, profile-iop, level_idc)
    // immediately following the NAL header byte, encoded as 6 hex chars.
    const profileLevelId = sps.subarray(1, 4).toString('hex').toUpperCase();
    const spropParameterSets = sps.toString('base64') + ',' + pps.toString('base64');
    return (
        [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=Kasa',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            'm=video 0 RTP/AVP 96',
            'a=rtpmap:96 H264/90000',
            `a=fmtp:96 packetization-mode=1; profile-level-id=${profileLevelId}; sprop-parameter-sets=${spropParameterSets}`,
            'a=control:trackID=0',
            'm=audio 0 RTP/AVP 0',
            'a=rtpmap:0 PCMU/8000',
            'a=control:trackID=1',
        ].join('\r\n') + '\r\n'
    );
}

// Reads parts until the bitstream has shown both SPS and PPS. The parts themselves are not
// kept: no RTSP client can be connected yet (the server isn't listening), so there is nobody
// to replay them to, and the consumer starts decoding at the next IDR anyway.
async function preScanSpsPps(kasa: KasaClient): Promise<{ sps: Buffer; pps: Buffer }> {
    const found: { sps?: Buffer; pps?: Buffer } = {};
    const deadline = Date.now() + SPS_PPS_TIMEOUT_MS;
    while (!found.sps || !found.pps) {
        if (Date.now() > deadline) throw new Error('timed out waiting for H.264 SPS/PPS');
        const part = await kasa.readPart();
        if (part.contentType === KasaMimeVideo) findSpsPps(part.body, found);
    }
    // Copies: findSpsPps returns views into the part, so a caller that keeps them would
    // otherwise pin the whole IDR (80+ KB).
    return { sps: Buffer.from(found.sps), pps: Buffer.from(found.pps) };
}

// Compute an RTP timestamp at `clockHz` from a process.hrtime delta in nanoseconds.
// 32-bit unsigned wrap is the RTP norm — receivers handle wrap.
function nanosToRtp(deltaNs: bigint, clockHz: number): number {
    // BigInt multiply keeps precision for clockHz=90000 over hours of streaming.
    const ticks = (deltaNs * BigInt(clockHz)) / 1_000_000_000n;
    return Number(ticks & 0xffffffffn) >>> 0;
}

// Orchestrates the kasa→consumer streaming pipeline:
//   kasa multipart → native RTP packetizer → RTSP TCP-interleaved frames → consumer
//
// No ffmpeg subprocess, no UDP loopback hop, no extra forwarder layer. The kasa parts
// already carry the codecs we serve (annex-b H.264, G.711 µ-law); ffmpeg's only job in
// the previous design was RTP packetization, which is well-defined enough to do directly.
//
// Returns a handle whose `kill()` tears down everything (kasa, TCP server, active
// client) and whose `exited` promise resolves once that teardown is done.
export async function spawnKasaStream(opts: KasaStreamOptions): Promise<KasaStreamHandle> {
    const { kasa, console, cachedSps, cachedPps, onFreshSpsPps } = opts;

    // Fast path: caller supplied cached SPS/PPS from a previous session. Skip the scan and
    // start streaming live parts immediately — saves the ~1-2s preScanSpsPps wait on cold
    // starts, which dominates HomeKit's perceived stream-open latency.
    // Validate cached buffers before trusting them. Storage corruption / schema drift /
    // mistakenly-stored garbage would otherwise produce an SDP with an invalid
    // profile-level-id (derived from sps[1..4]) or sprop-parameter-sets, and consumers
    // would fail SETUP rather than recovering from in-band SPS/PPS.
    // H.264 NAL header byte: low 5 bits = nal_unit_type. SPS = 7, PPS = 8.
    // SPS minimum length = 4 (NAL header byte + 3 profile bytes used in the SDP).
    const cacheValid =
        !!cachedSps &&
        !!cachedPps &&
        cachedSps.length >= 4 &&
        cachedPps.length >= 1 &&
        (cachedSps[0] & 0x1f) === 7 &&
        (cachedPps[0] & 0x1f) === 8;
    if ((cachedSps || cachedPps) && !cacheValid) {
        console.warn('[kasa-stream] cached SPS/PPS failed validation; falling back to in-band scan');
    }

    let sps: Buffer;
    let pps: Buffer;
    if (cacheValid) {
        sps = cachedSps!;
        pps = cachedPps!;
    } else {
        ({ sps, pps } = await preScanSpsPps(kasa));
        try {
            onFreshSpsPps?.(sps, pps);
        } catch (e) {
            console.warn('[kasa-stream] onFreshSpsPps callback threw', e);
        }
    }
    const sdp = buildSdp(sps, pps);

    // Packetizers carry seq + SSRC across the whole session. Each packet is allocated with
    // room in front for the RTSP interleaved header, so sending it doesn't copy it again.
    const h264 = new H264RtpPacketizer(RTSP_INTERLEAVED_HEADER_LEN);
    const g711 = new G711RtpPacketizer(RTSP_INTERLEAVED_HEADER_LEN);

    // Active forwarder — populated when the RTSP client PLAYs, cleared on teardown.
    interface ActiveForwarder {
        send: (channel: number, packet: Buffer) => boolean;
        videoRtp: number;
        videoRtcp: number;
        audioRtp: number;
        audioRtcp: number;
    }
    let active: ActiveForwarder | null = null;

    let tcpServer: net.Server | undefined = undefined;
    let activeClient: net.Socket | undefined = undefined;
    let unregisterCleanup: (() => void) | undefined = undefined;
    let rtcpInterval: NodeJS.Timeout | undefined = undefined;

    let resolveExited!: () => void;
    const exited = new Promise<void>(r => {
        resolveExited = r;
    });

    let killed = false;
    const cleanupAll = () => {
        if (killed) return;
        killed = true;
        try {
            unregisterCleanup?.();
        } catch {}
        if (rtcpInterval) {
            clearInterval(rtcpInterval);
            rtcpInterval = undefined;
        }
        try {
            tcpServer?.close();
        } catch {}
        try {
            activeClient?.destroy();
        } catch {}
        try {
            kasa.destroy();
        } catch {}
        active = null;
        resolveExited();
    };
    unregisterCleanup = registerLiveCleanup(cleanupAll);

    // Pump kasa parts directly into the active forwarder. No intermediate process, pipe,
    // or UDP hop. Drops parts until the RTSP client PLAYs (i.e. while `active` is null —
    // start-up race only; we don't implement PAUSE semantics, since live consumers
    // either keep playing or TEARDOWN). Backpressure: handled inside rtsp.ts `send` —
    // drops while Node's userland write queue is full and tears down the client if the
    // queued bytes cross a hard cap. From here we just call send and let it decide.
    const pump = async () => {
        const t0 = process.hrtime.bigint();
        // Audio RTP timestamps must advance by sample count, not wall-clock — RTP
        // receivers use the timestamp to drive playout, and any wall-clock-derived jitter
        // would surface as audible discontinuities. Initialize once on first audio part
        // (using elapsed time so audio and video share a roughly aligned origin), then
        // chain via the packetizer's return value across every subsequent part.
        let audioTs: number | undefined;
        const handlePart = (part: KasaPart) => {
            if (killed) return;
            if (!active) return;
            const fwd = active;
            const elapsed = process.hrtime.bigint() - t0;
            if (part.contentType === KasaMimeVideo) {
                const ts = nanosToRtp(elapsed, H264_CLOCK_HZ);
                h264.packetize(part.body, ts, pkt => {
                    if (active === fwd) fwd.send(fwd.videoRtp, pkt);
                });
            } else if (part.contentType === KasaMimeG711U) {
                if (audioTs === undefined) audioTs = nanosToRtp(elapsed, G711_CLOCK_HZ);
                audioTs = g711.packetize(part.body, audioTs, pkt => {
                    if (active === fwd) fwd.send(fwd.audioRtp, pkt);
                });
            }
        };

        try {
            while (!killed) {
                const part = await kasa.readPart();
                handlePart(part);
            }
        } catch (e) {
            if (!killed) console.warn('[kasa-stream] pump error', (e as Error).message);
        } finally {
            cleanupAll();
        }
    };
    void pump();

    // Bind the RTSP listener last, after all the supporting pieces are in place.
    tcpServer = net.createServer();

    tcpServer.on('connection', client => {
        // tcpServer.close() in cleanupAll only stops accepting NEW connections; an inflight
        // accept can still fire 'connection' after we've started teardown. Reject those so
        // the late client doesn't become activeClient and leak.
        if (killed) {
            client.destroy();
            return;
        }
        if (activeClient) {
            // We only serve one consumer per stream session. Reject anything else.
            client.destroy();
            return;
        }
        // RTSP-over-TCP-interleaved frames are small (~4 B header + RTP packet). Disable
        // Nagle so frame headers don't get held up to 200 ms hoping to coalesce.
        client.setNoDelay(true);
        activeClient = client;
        handleRtspClient(client, {
            sdp,
            console,
            onPlay(send, channels) {
                active = {
                    send,
                    videoRtp: channels.video.rtp,
                    videoRtcp: channels.video.rtcp,
                    audioRtp: channels.audio.rtp,
                    audioRtcp: channels.audio.rtcp,
                };
                // Periodic RTCP Sender Reports. Receivers map each track's RTP timeline
                // to wall-clock NTP via SRs to keep audio/video in sync — the prior ffmpeg
                // pipeline emitted them, so generating a minimal SR every 5 s keeps
                // behavior parity. A single SR per track is ~28 B; cost is negligible.
                rtcpInterval = setInterval(() => {
                    if (!active || killed) return;
                    const ntp = nowNtp();
                    const vsr = h264.senderReport(ntp);
                    if (vsr) active.send(active.videoRtcp, vsr);
                    const asr = g711.senderReport(ntp);
                    if (asr) active.send(active.audioRtcp, asr);
                }, 5000);
            },
            onTeardown: cleanupAll,
        });
    });

    await new Promise<void>((resolve, reject) => {
        let listening = false;
        tcpServer!.once('error', reject);
        tcpServer!.listen(0, '127.0.0.1', () => {
            listening = true;
            tcpServer!.removeListener('error', reject);
            resolve();
        });
        // The pump is already running and can end the stream first (the camera closed the
        // body, or the first part was malformed). close() in cleanupAll cancels a pending
        // listen without emitting 'listening' or 'error', so nothing above would settle.
        void exited.then(() => {
            if (!listening) reject(new Error('kasa stream ended before the RTSP server started'));
        });
    });
    const url = `rtsp://127.0.0.1:${(tcpServer.address() as net.AddressInfo).port}/kasa`;

    return {
        url,
        kill: cleanupAll,
        exited,
    };
}
