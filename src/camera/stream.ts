import net from 'net';
import { findSpsPps, KasaClient, KasaMimeG711U, KasaMimeVideo, KasaPart } from './api';
import { G711_CLOCK_HZ, G711RtpPacketizer, H264_CLOCK_HZ, H264RtpPacketizer } from './rtp';
import { handleRtspClient } from './rtsp';

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
// Belt-and-suspenders caps on the prebuffer. The timeout already bounds the wait, but a
// camera that streams at high bitrate and never emits SPS/PPS could fill memory before the
// timer fires. Either trip throws.
const SPS_PPS_MAX_BUFFERED_PARTS = 1024;
const SPS_PPS_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

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

async function preScanSpsPps(kasa: KasaClient): Promise<{ sps: Buffer; pps: Buffer; buffered: KasaPart[] }> {
    const buffered: KasaPart[] = [];
    let bufferedBytes = 0;
    const found: { sps?: Buffer; pps?: Buffer } = {};
    const deadline = Date.now() + SPS_PPS_TIMEOUT_MS;
    while (!found.sps || !found.pps) {
        if (Date.now() > deadline) throw new Error('timed out waiting for H.264 SPS/PPS');
        if (buffered.length >= SPS_PPS_MAX_BUFFERED_PARTS)
            throw new Error(`H.264 SPS/PPS not found within ${SPS_PPS_MAX_BUFFERED_PARTS} parts`);
        if (bufferedBytes >= SPS_PPS_MAX_BUFFERED_BYTES)
            throw new Error(`H.264 SPS/PPS not found within ${SPS_PPS_MAX_BUFFERED_BYTES} prebuffered bytes`);
        const part = await kasa.readPart();
        buffered.push(part);
        bufferedBytes += part.body.length;
        if (part.contentType === KasaMimeVideo) findSpsPps(part.body, found);
    }
    return { sps: found.sps!, pps: found.pps!, buffered };
}

// Reserve a TCP port on localhost for the RTSP server. Brief TOCTOU window between close
// and re-bind is accepted — nothing else snatches loopback ports in those few ms.
async function reserveTcpPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(port));
        });
    });
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
    let buffered: KasaPart[];
    if (cacheValid) {
        sps = cachedSps!;
        pps = cachedPps!;
        buffered = [];
    } else {
        const scanned = await preScanSpsPps(kasa);
        sps = scanned.sps;
        pps = scanned.pps;
        buffered = scanned.buffered;
        try {
            onFreshSpsPps?.(sps, pps);
        } catch (e) {
            console.warn('[kasa-stream] onFreshSpsPps callback threw', e);
        }
    }
    const sdp = buildSdp(sps, pps);

    // Packetizers carry seq + SSRC across the whole session.
    const h264 = new H264RtpPacketizer();
    const g711 = new G711RtpPacketizer();

    // Active forwarder — populated when the RTSP client PLAYs, cleared on teardown.
    interface ActiveForwarder {
        send: (channel: number, packet: Buffer) => boolean;
        videoRtp: number;
        audioRtp: number;
    }
    let active: ActiveForwarder | null = null;

    let tcpServer: net.Server | undefined = undefined;
    let activeClient: net.Socket | undefined = undefined;
    let unregisterCleanup: (() => void) | undefined = undefined;

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
    // or UDP hop. Drops parts when no client is attached (start-up race or paused stream).
    // Backpressure: client.write() returns false on TCP backpressure but we don't await
    // drain — for live video, blocking the read loop on a slow consumer would just grow
    // latency. If a consumer can't keep up the stream will visibly stutter, which is the
    // right failure mode (vs. ballooning RAM or stalling other cameras).
    const pump = async () => {
        const t0 = process.hrtime.bigint();
        const replay = buffered;
        buffered = [];
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
                const ts = nanosToRtp(elapsed, G711_CLOCK_HZ);
                g711.packetize(part.body, ts, pkt => {
                    if (active === fwd) fwd.send(fwd.audioRtp, pkt);
                });
            }
        };

        try {
            for (const part of replay) handlePart(part);
            // Release prebuffered parts (up to a few hundred KB each) — they were captured
            // during the SPS/PPS scan and are only needed for this single replay.
            replay.length = 0;
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
    const rtspPort = await reserveTcpPort();
    const url = `rtsp://127.0.0.1:${rtspPort}/kasa`;

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
                    audioRtp: channels.audio.rtp,
                };
            },
            onTeardown: cleanupAll,
        });
    });

    await new Promise<void>((resolve, reject) => {
        tcpServer!.once('error', reject);
        tcpServer!.listen(rtspPort, '127.0.0.1', () => {
            tcpServer!.removeListener('error', reject);
            resolve();
        });
    });

    return {
        url,
        kill: cleanupAll,
        exited,
    };
}
