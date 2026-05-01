import child_process from 'child_process';
import dgram from 'dgram';
import { once } from 'events';
import net from 'net';
import { Writable } from 'stream';
import { findSpsPps, KasaClient, KasaMimeG711U, KasaMimeVideo, KasaPart } from './api';
import { handleRtspClient } from './rtsp';

// Process-level cleanup registry. Scrypted runs plugins as worker threads, and child
// processes spawned by a worker survive the worker's termination — they're owned by the
// host Node process. So when our plugin gets unloaded (or even when the worker crashes),
// any in-flight ffmpeg subprocess + kasa HTTPS connection would otherwise leak. We catch
// that here: every spawnKasaStream and intercom-ffmpeg registers its kill function and
// removes itself on normal teardown. On worker exit, the hook nukes anything still live.
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
    ffmpegPath: string;
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

interface BoundUdp {
    socket: dgram.Socket;
    port: number;
}

interface UdpPair {
    rtp: BoundUdp;
    rtcp: BoundUdp;
}

// 1 MB UDP receive buffer — comfortably absorbs an IDR-frame burst on the localhost hop
// from ffmpeg, which can be 100+ RTP packets arriving back-to-back. The default Linux
// SO_RCVBUF (~200 KB) overflows on 1080p H.264 IDRs and drops fragments, surfacing as
// "fua packet missing" in downstream consumers.
const UDP_RECV_BUFFER_BYTES = 1024 * 1024;

async function bindUdp(port: number = 0): Promise<BoundUdp> {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => {
            sock.removeListener('listening', onListen);
            reject(e);
        };
        const onListen = () => {
            sock.removeListener('error', onError);
            resolve();
        };
        sock.once('error', onError);
        sock.once('listening', onListen);
        sock.bind(port, '127.0.0.1');
    });
    // setRecvBufferSize tries to bump SO_RCVBUF; the kernel caps it at net.core.rmem_max
    // (often 200 KB on stock Linux, 2+ MB on most server distros). We don't fail if the
    // bump is rejected — small buffer just means we may drop on big bursts.
    try {
        sock.setRecvBufferSize(UDP_RECV_BUFFER_BYTES);
    } catch {
        /* best-effort */
    }
    return { socket: sock, port: (sock.address() as { port: number }).port };
}

// Bind a (RTP, RTP+1) UDP pair so RTCP gets the conventional next port. ffmpeg's `-f rtp`
// output assumes RTP+1 for RTCP unless rtcpport= overrides; binding the pair ourselves
// keeps the wiring straightforward. Retry up to 10 times in case RTP+1 is already taken.
async function bindUdpPair(): Promise<UdpPair> {
    for (let attempt = 0; attempt < 10; attempt++) {
        const rtp = await bindUdp();
        try {
            const rtcp = await bindUdp(rtp.port + 1);
            return { rtp, rtcp };
        } catch {
            rtp.socket.close();
        }
    }
    throw new Error('failed to bind sequential RTP/RTCP udp pair after 10 tries');
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

// Replays the buffered parts captured during the SPS/PPS scan (so ffmpeg sees the
// SPS+PPS+IDR sequence required to start decoding) then continues pumping live parts. We
// honor backpressure: if ffmpeg falls behind (CPU spike, paused consumer, etc.), ignoring
// drain would let Node's write buffer grow without bound. Awaiting drain throttles the
// camera read loop instead — the camera's TCP receive window will fill up and the kernel
// will pause it for us.
async function pumpKasa(
    kasa: KasaClient,
    videoPipe: Writable,
    audioPipe: Writable,
    prebuffered: KasaPart[],
): Promise<void> {
    const writePart = async (part: KasaPart) => {
        const pipe =
            part.contentType === KasaMimeVideo ? videoPipe : part.contentType === KasaMimeG711U ? audioPipe : undefined;
        if (!pipe || pipe.writableEnded || pipe.destroyed) return;
        if (!pipe.write(part.body)) {
            // Race 'drain' against teardown. If the pipe closes/errors before draining,
            // 'drain' never fires and the pump would hang forever. AbortController removes
            // the losing listeners after the race so frequent backpressure cycles don't
            // accumulate listeners on the pipe.
            const ac = new AbortController();
            try {
                await Promise.race([
                    once(pipe, 'drain', { signal: ac.signal }).catch(() => {}),
                    once(pipe, 'close', { signal: ac.signal }).catch(() => {}),
                    once(pipe, 'error', { signal: ac.signal }).catch(() => {}),
                ]);
            } finally {
                ac.abort();
            }
        }
    };

    try {
        for (const part of prebuffered) await writePart(part);
        // Release prebuffered parts (up to a few hundred KB each) — they were captured
        // during the SPS/PPS scan and are only needed for this single replay.
        prebuffered.length = 0;
        while (true) {
            const part = await kasa.readPart();
            await writePart(part);
        }
    } finally {
        try {
            videoPipe.end();
        } catch {}
        try {
            audioPipe.end();
        } catch {}
    }
}

// Orchestrates the kasa→consumer streaming pipeline:
//   kasa multipart → ffmpeg pipe inputs (codec copy) → RTP UDP outputs
//                  → minimal RTSP server forwards UDP RTP as TCP-interleaved frames
//                  → consumer reads via rtsp:// URL
//
// Returns a handle whose `kill()` tears down everything (kasa, ffmpeg, UDP sockets, TCP
// server, active client) and whose `exited` promise resolves once that teardown is done.
export async function spawnKasaStream(opts: KasaStreamOptions): Promise<KasaStreamHandle> {
    const { kasa, ffmpegPath, console, cachedSps, cachedPps, onFreshSpsPps } = opts;

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
        // Caller will overwrite the bad cache via onFreshSpsPps below once the slow path
        // produces fresh values; nothing to do here beyond logging and falling through.
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
        // Persist for next time. Pass the original error object (not just .message) so
        // stack/context survive — non-Error throws would lose everything otherwise.
        try {
            onFreshSpsPps?.(sps, pps);
        } catch (e) {
            console.warn('[kasa-stream] onFreshSpsPps callback threw', e);
        }
    }
    const sdp = buildSdp(sps, pps);

    const videoUdp = await bindUdpPair();
    const audioUdp = await bindUdpPair();

    // Two RTP outputs, one per track. `-vn`/`-an` per output filter the unwanted side
    // rather than using `-map`. Explicit -payload_type lines pin the PTs to the values our
    // SDP advertises (96 for H.264, 0 for PCMU) so a future ffmpeg default change can't
    // silently break the SDP/stream contract.
    // prettier-ignore
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-thread_queue_size', '1024',
        '-f', 'h264',
        '-i', 'pipe:3',
        '-thread_queue_size', '1024',
        '-f', 'mulaw',
        '-ar', '8000',
        '-ac', '1',
        '-i', 'pipe:4',
        '-vcodec', 'copy', '-an', '-dn', '-sn',
        '-f', 'rtp',
        '-payload_type', '96',
        `rtp://127.0.0.1:${videoUdp.rtp.port}?rtcpport=${videoUdp.rtcp.port}`,
        '-acodec', 'copy', '-vn', '-dn', '-sn',
        '-f', 'rtp',
        '-payload_type', '0',
        `rtp://127.0.0.1:${audioUdp.rtp.port}?rtcpport=${audioUdp.rtcp.port}`,
    ];

    const cp = child_process.spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    cp.stderr?.on('data', d => {
        const text = d.toString().trim();
        if (text) console.log('[kasa-ffmpeg]', text);
    });

    const videoPipe = cp.stdio[3] as Writable;
    const audioPipe = cp.stdio[4] as Writable;

    // Attach 'error' listeners on both pipes IMMEDIATELY. When cleanupAll calls cp.kill,
    // ffmpeg's stdio FDs close forcibly and any in-flight pump write throws ECONNRESET /
    // EPIPE on the writable side. Without listeners, Node turns those into
    // uncaughtException and crashes the whole plugin worker (taking down every camera).
    // The `_e` arg is intentional — we just want the stream to be informed there's a
    // listener.
    videoPipe.on('error', _e => {
        /* tear down via the kasa pump's own try/finally */
    });
    audioPipe.on('error', _e => {
        /* tear down via the kasa pump's own try/finally */
    });

    let resolveExited!: () => void;
    const exited = new Promise<void>(r => {
        resolveExited = r;
    });

    // Forward-declare anything cleanupAll touches that's initialized later in the function.
    // ffmpeg's `exit`/`error` events or a pump throw can fire cleanupAll while we're still
    // awaiting `reserveTcpPort()` below — referencing TDZ const bindings here would throw
    // an uncaught ReferenceError and skip the rest of teardown. Explicit `= undefined` so
    // eslint's prefer-const sees the later reassignment.
    let tcpServer: net.Server | undefined = undefined;
    let activeClient: net.Socket | undefined = undefined;
    let unregisterCleanup: (() => void) | undefined = undefined;

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
        try {
            cp.kill('SIGKILL');
        } catch {}
        try {
            videoUdp.rtp.socket.close();
        } catch {}
        try {
            videoUdp.rtcp.socket.close();
        } catch {}
        try {
            audioUdp.rtp.socket.close();
        } catch {}
        try {
            audioUdp.rtcp.socket.close();
        } catch {}
        resolveExited();
    };
    // Register with the process-level cleanup registry so worker termination kills the
    // ffmpeg subprocess + closes the kasa connection even if our normal teardown path
    // (release(), kill switch, ffmpeg exit) didn't run.
    unregisterCleanup = registerLiveCleanup(cleanupAll);

    // ffmpeg exit (or spawn error) is itself a teardown trigger.
    cp.once('exit', cleanupAll);
    cp.once('error', cleanupAll);

    // Pump kasa → ffmpeg pipes. If the pump throws (kasa stream ended/errored), tear down.
    // We suppress the warn when `killed` is already set, because that means our own
    // cleanupAll destroyed the kasa connection and the resulting "stream ended" throw is
    // expected close-sequence noise, not a real error.
    pumpKasa(kasa, videoPipe, audioPipe, buffered)
        .catch(e => {
            if (!killed) console.warn('[kasa-stream] pump error', (e as Error).message);
        })
        .finally(cleanupAll);

    // Forwarding state — populated atomically when the RTSP client PLAYs, used by the
    // always-attached UDP message handlers below. One reference instead of two so the
    // handlers can't observe a half-set state under any scheduling.
    interface ActiveForwarder {
        send: (channel: number, packet: Buffer) => boolean;
        videoRtp: number;
        videoRtcp: number;
        audioRtp: number;
        audioRtcp: number;
    }
    let active: ActiveForwarder | null = null;

    // Attach UDP listeners IMMEDIATELY (not on PLAY) so the kernel buffer gets drained as
    // soon as ffmpeg starts producing packets. Without this, packets sent before the RTSP
    // client connects pile up in SO_RCVBUF and either get dropped on overflow, or block
    // libuv from polling the socket cleanly. Until `active` is set, we just discard.
    videoUdp.rtp.socket.on('message', msg => {
        if (active) active.send(active.videoRtp, msg);
    });
    videoUdp.rtcp.socket.on('message', msg => {
        if (active) active.send(active.videoRtcp, msg);
    });
    audioUdp.rtp.socket.on('message', msg => {
        if (active) active.send(active.audioRtp, msg);
    });
    audioUdp.rtcp.socket.on('message', msg => {
        if (active) active.send(active.audioRtcp, msg);
    });

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
                    videoRtcp: channels.video.rtcp,
                    audioRtp: channels.audio.rtp,
                    audioRtcp: channels.audio.rtcp,
                };
            },
            onTeardown: cleanupAll,
        });
    });

    await new Promise<void>((resolve, reject) => {
        tcpServer.once('error', reject);
        tcpServer.listen(rtspPort, '127.0.0.1', () => {
            tcpServer.removeListener('error', reject);
            resolve();
        });
    });

    return {
        url,
        kill: cleanupAll,
        exited,
    };
}
