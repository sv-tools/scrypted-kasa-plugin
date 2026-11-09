import https from 'https';
import type { IncomingMessage } from 'http';
import type { Readable } from 'stream';
import { kasaStreamAuth, markStaleSocket, retryStaleSocketOnce } from './http';

// Kasa cameras serve a non-standard mixed multipart stream over HTTPS on this port/path.
// Reverse-engineered: https://medium.com/@hu3vjeen/reverse-engineering-tp-link-kc100-bac4641bf1cd
export const KASA_DEFAULT_PORT = 19443;
export const KASA_STREAM_PATH = '/https/stream/mixed';

// Real headers from this camera fit in well under 1 KB. Cap at 32 KB so a malformed framing
// (or an attacker who substitutes a non-Kasa endpoint) can't grow the queued chunks until
// the stream eventually ends. Throwing here surfaces the problem instead of silently
// retaining memory.
const MAX_HEADER_BYTES = 32 * 1024;

// Connect-phase idle timeout: while establishing the HTTPS request and waiting for response
// headers, fires only if the socket is idle for this long. Covers TLS handshake hangs and
// unresponsive-but-routable cameras — but it's not a strict wall-clock deadline if there
// is intermittent socket activity without headers arriving. Once headers arrive we clear
// the socket timeout because kasa cameras on marginal Wi-Fi can go briefly silent (channel
// scan, AP roam, transient congestion) and recover; killing the stream on every such gap
// causes more harm than good. Half-open TCP detection is delegated to OS keepalive (see
// setKeepAlive below) so a Wi-Fi drop without a clean FIN still gets cleaned up.
const KASA_STREAM_CONNECT_TIMEOUT_MS = 10000;

// Initial idle before the OS sends the first TCP keepalive probe on the streaming socket.
// During normal streaming, frame-level data activity resets this timer so probes never
// fire. If the connection dies (Wi-Fi drop, NAT timeout, switch reset), keepalive probes
// eventually cause the OS to close the socket and our `body.on('close')` triggers teardown.
// Note: `socket.setKeepAlive(true, initialDelay)` controls only this initial idle period
// (TCP_KEEPIDLE); total detection/teardown time still depends on OS-level keepalive
// interval (TCP_KEEPINTVL) and probe count (TCP_KEEPCNT). Linux defaults are often too
// slow for a live video stream (TCP_KEEPIDLE may default to 7200 s), so 30 s here just
// starts probing sooner after the stream goes idle.
const KASA_STREAM_KEEPALIVE_INITIAL_DELAY_MS = 30000;

export const KasaMimeVideo = 'video/x-h264';
export const KasaMimeG711U = 'audio/g711u';

const H264_NAL_TYPE_SPS = 7;
const H264_NAL_TYPE_PPS = 8;

export interface H264SpsPps {
    sps?: Buffer;
    pps?: Buffer;
}

// Scans an annex-b H.264 buffer (NALs prefixed by 00 00 01 or 00 00 00 01) for SPS (type 7)
// and PPS (type 8). Mutates `found` so callers can accumulate across multiple parts; once both
// are set further calls are cheap and idempotent.
export function findSpsPps(annexb: Buffer, found: H264SpsPps = {}): H264SpsPps {
    const len = annexb.length;
    let i = 0;
    while (i < len) {
        let nalStart = -1;
        if (i + 2 < len && annexb[i] === 0 && annexb[i + 1] === 0) {
            if (annexb[i + 2] === 1) nalStart = i + 3;
            else if (i + 3 < len && annexb[i + 2] === 0 && annexb[i + 3] === 1) nalStart = i + 4;
        }
        if (nalStart < 0) {
            i++;
            continue;
        }
        // Walk forward to the next start code; if none, the NAL runs to end-of-buffer.
        let nalEnd = len;
        for (let j = nalStart + 1; j + 2 < len; j++) {
            if (
                annexb[j] === 0 &&
                annexb[j + 1] === 0 &&
                (annexb[j + 2] === 1 || (j + 3 < len && annexb[j + 2] === 0 && annexb[j + 3] === 1))
            ) {
                nalEnd = j;
                break;
            }
        }
        const nalType = annexb[nalStart] & 0x1f;
        if (nalType === H264_NAL_TYPE_SPS && !found.sps) found.sps = annexb.subarray(nalStart, nalEnd);
        else if (nalType === H264_NAL_TYPE_PPS && !found.pps) found.pps = annexb.subarray(nalStart, nalEnd);
        i = nalEnd;
    }
    return found;
}

export interface KasaConnectOptions {
    ip: string;
    port?: number;
    username: string;
    password: string;
}

export interface KasaPart {
    contentType: string;
    body: Buffer;
}

// A still JPEG served by the stream server alongside the live stream; the one-connection limit
// applies to /https/stream/mixed only, so this works while the stream is being watched. The
// firmware copies a fixed 640x360 frame and reads no query parameters, so there is no way to ask
// for a larger one. A camera that is turned off (Privacy Mode) answers HTTP 503.
export const KASA_SNAPSHOT_PATH = '/https/stream/snapshot.jpg';
const KASA_SNAPSHOT_TIMEOUT_MS = 10000;
// A real snapshot is ~60-110 KB; anything far larger isn't one.
const KASA_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export class KasaSnapshotError extends Error {
    constructor(
        message: string,
        public statusCode?: number,
    ) {
        super(message);
    }
}

export async function fetchKasaSnapshot(options: KasaConnectOptions): Promise<Buffer> {
    const auth = kasaStreamAuth(options.username, options.password);
    // Snapshots go through Node's default agent, which keeps the connection for the next one.
    return retryStaleSocketOnce(() => sendSnapshotRequest(options, auth));
}

function sendSnapshotRequest(options: KasaConnectOptions, auth: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
        const req = https.request(
            {
                host: options.ip,
                port: options.port || KASA_DEFAULT_PORT,
                method: 'GET',
                path: KASA_SNAPSHOT_PATH,
                rejectUnauthorized: false,
                headers: { Authorization: auth, Accept: 'image/*' },
            },
            res => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new KasaSnapshotError(`kasa snapshot HTTP ${res.statusCode}`, res.statusCode));
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (c: Buffer) => {
                    size += c.length;
                    if (size > KASA_SNAPSHOT_MAX_BYTES) {
                        req.destroy(
                            new KasaSnapshotError(`kasa snapshot larger than ${KASA_SNAPSHOT_MAX_BYTES} bytes`),
                        );
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => {
                    const body = Buffer.concat(chunks);
                    // JPEG SOI marker; the camera labels it image/jpg, so don't trust the header.
                    if (body.length < 2 || body[0] !== 0xff || body[1] !== 0xd8) {
                        reject(new KasaSnapshotError('kasa snapshot is not a JPEG'));
                        return;
                    }
                    resolve(body);
                });
                res.on('error', reject);
            },
        );
        req.setTimeout(KASA_SNAPSHOT_TIMEOUT_MS, () => {
            req.destroy(new KasaSnapshotError(`kasa snapshot timeout after ${KASA_SNAPSHOT_TIMEOUT_MS}ms`));
        });
        req.on('error', e => reject(markStaleSocket(req, e)));
        req.end();
    });
}

export class KasaClient {
    body!: IncomingMessage;
    boundary!: string;

    static async connect(options: KasaConnectOptions): Promise<KasaClient> {
        const port = options.port || KASA_DEFAULT_PORT;
        // Pre-emptive Basic auth — the camera doesn't send a 401 challenge before serving
        // the multipart stream; the very first request must already include credentials.
        // (No need for the auth-fetch challenge/retry dance other endpoints use.)
        const auth = kasaStreamAuth(options.username, options.password);

        // Cameras present a self-signed cert. The body is consumed as a long-lived stream
        // rather than buffered to completion, so we don't read the response body here.
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const req = https.request(
                {
                    host: options.ip,
                    port,
                    method: 'GET',
                    path: KASA_STREAM_PATH,
                    // Its own connection, never one from the default agent's pool: a snapshot
                    // leaves a kept-alive socket to this same port there, and if the camera has
                    // since closed it the stream request would fail on it.
                    agent: false,
                    rejectUnauthorized: false,
                    headers: {
                        Authorization: auth,
                        Accept: '*/*',
                        Connection: 'keep-alive',
                    },
                },
                response => {
                    // Headers in — clear the connect-phase idle timeout so it doesn't
                    // keep firing during normal streaming gaps. setTimeout(0) on the
                    // underlying socket disables Node's idle-timeout machinery.
                    response.socket?.setTimeout(0);
                    // Enable OS-level TCP keepalive as a safety net for half-open
                    // detection. During normal streaming the data flow keeps this from
                    // firing, but if Wi-Fi drops / NAT times out without a clean FIN,
                    // keepalive probes will eventually fail and the kernel will close
                    // the socket — without keepalive we'd block forever in readPart()
                    // waiting for a multipart header that never arrives.
                    response.socket?.setKeepAlive(true, KASA_STREAM_KEEPALIVE_INITIAL_DELAY_MS);
                    resolve(response);
                },
            );
            req.setTimeout(KASA_STREAM_CONNECT_TIMEOUT_MS, () => {
                req.destroy(new Error(`kasa stream connect timeout after ${KASA_STREAM_CONNECT_TIMEOUT_MS}ms`));
            });
            req.on('error', reject);
            req.end();
        });

        if (response.statusCode && response.statusCode >= 400) {
            response.destroy();
            throw new Error(`kasa stream HTTP ${response.statusCode}`);
        }

        const contentType = (response.headers['content-type'] || '') as string;
        if (!/multipart\/x-mixed-replace/i.test(contentType)) {
            response.destroy();
            throw new Error(`unexpected content-type: ${contentType}`);
        }

        const m = /boundary=([^;\s]+)/i.exec(contentType);
        if (!m) {
            response.destroy();
            throw new Error(`missing boundary in content-type: ${contentType}`);
        }

        const client = new KasaClient();
        client.body = response;
        client.boundary = m[1];
        return client;
    }

    destroy() {
        this.body?.destroy();
    }

    async readPart(): Promise<KasaPart> {
        const expected = '--' + this.boundary;

        // Read the boundary + header block as one buffer (terminated by a blank line) and
        // walk it byte-wise to extract just content-type and content-length. At ~30 parts/s
        // this avoids the regex split and ~6 string allocations per part that a per-line
        // approach would do.
        const headerBlock = await readUntilDoubleCrlf(this.body);
        const len = headerBlock.length;

        // Pull out the next \r\n- or \n-terminated line as a string. Returns the slice plus
        // the index just after the line terminator. Skips leading blank lines so a stray
        // CRLF before the boundary (some firmwares) doesn't break parsing.
        const nextLine = (start: number): { line: string; next: number } => {
            let i = start;
            // Find next LF.
            while (i < len && headerBlock[i] !== 0x0a) i++;
            // Trim a trailing CR if present.
            const end = i > start && headerBlock[i - 1] === 0x0d ? i - 1 : i;
            return { line: headerBlock.toString('utf8', start, end), next: i + 1 };
        };

        let pos = 0;
        // Tolerate leading empty lines.
        while (pos < len) {
            const { line, next } = nextLine(pos);
            if (line) {
                if (line !== expected) throw new Error(`unexpected boundary line: ${JSON.stringify(line)}`);
                pos = next;
                break;
            }
            pos = next;
        }

        let contentType = '';
        let length = -1;
        while (pos < len) {
            const { line, next } = nextLine(pos);
            pos = next;
            if (!line) break;
            // Header names from this camera are stable (`Content-Type:`, `Content-Length:`),
            // but match case-insensitively to tolerate firmware revisions.
            if (line.length > 13 && line.charCodeAt(12) === 0x3a /* : */) {
                const name = line.slice(0, 12);
                if (name === 'Content-Type' || name.toLowerCase() === 'content-type') {
                    contentType = line.slice(13).trim();
                    continue;
                }
            }
            if (line.length > 15 && line.charCodeAt(14) === 0x3a) {
                const name = line.slice(0, 14);
                if (name === 'Content-Length' || name.toLowerCase() === 'content-length') {
                    const n = parseInt(line.slice(15).trim(), 10);
                    if (Number.isFinite(n) && n >= 0) length = n;
                    continue;
                }
            }
        }

        if (length < 0) throw new Error('multipart: no/invalid content length');

        const body = length === 0 ? Buffer.alloc(0) : await readLength(this.body, length);
        return { contentType, body };
    }
}

// Read exactly `length` bytes from a Readable. Returns when the bytes are available;
// throws if the stream ends before that.
async function readLength(readable: Readable, length: number): Promise<Buffer> {
    if (readable.readableEnded || readable.destroyed) throw new Error('kasa stream ended before readLength');

    {
        const ret = readable.read(length);
        if (ret) return ret;
    }

    return new Promise<Buffer>((resolve, reject) => {
        const onReadable = () => {
            const ret = readable.read(length);
            if (ret) {
                cleanup();
                resolve(ret);
            }
        };
        const onEnd = () => {
            cleanup();
            reject(new Error('kasa stream ended during readLength'));
        };
        const cleanup = () => {
            readable.removeListener('readable', onReadable);
            readable.removeListener('end', onEnd);
            readable.removeListener('close', onEnd);
            readable.removeListener('error', onError);
        };
        const onError = (e: Error) => {
            cleanup();
            reject(e);
        };
        readable.on('readable', onReadable);
        readable.on('end', onEnd);
        readable.on('close', onEnd);
        readable.on('error', onError);
    });
}

// Resolves at the next 'readable', or when the stream ends, closes or fails; the caller loops
// and re-checks the stream, so one that is already finished can't strand it. Plain listeners,
// all removed on the first event: this runs for nearly every part (~80 times a second per
// camera), and leftover listeners would pile up over a long stream.
//
// Only for a caller that has just drained the stream with read(): attaching a 'readable'
// listener while data is still buffered makes Node emit 'readable' again at once, and a loop
// around that never yields to I/O. readLength, which waits with data buffered, keeps its
// listener attached instead.
function waitReadable(readable: Readable): Promise<void> {
    return new Promise<void>(resolve => {
        const done = () => {
            readable.removeListener('readable', done);
            readable.removeListener('end', done);
            readable.removeListener('close', done);
            readable.removeListener('error', done);
            resolve();
        };
        readable.on('readable', done);
        readable.on('end', done);
        readable.on('close', done);
        readable.on('error', done);
    });
}

// Read up to and including the first blank line (CRLF CRLF or LF LF) and return everything
// up to and including the terminator as a Buffer. Whatever bytes come after are unshifted
// back so the body that follows can be read intact. Enforces MAX_HEADER_BYTES so a malformed
// stream that never sends a terminator can't grow queued chunks unbounded.
async function readUntilDoubleCrlf(readable: Readable): Promise<Buffer> {
    const queued: Buffer[] = [];
    let queuedLen = 0;
    // crlf encodes how many bytes of \r\n\r\n we've matched: 0,1=\r, 2=\r\n, 3=\r\n\r, 4=done.
    // lfOnly counts consecutive \n bytes (some firmwares emit LF-only framing).
    let crlf = 0;
    let lfOnly = 0;
    while (true) {
        if (readable.readableEnded || readable.destroyed) throw new Error('kasa stream ended before headers');
        const chunk: Buffer | null = readable.read();
        if (!chunk) {
            await waitReadable(readable);
            continue;
        }
        let split = -1;
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            if (crlf === 0 && b === 0x0d) crlf = 1;
            else if (crlf === 1 && b === 0x0a) crlf = 2;
            else if (crlf === 2 && b === 0x0d) crlf = 3;
            else if (crlf === 3 && b === 0x0a) {
                split = i + 1;
                break;
            } else crlf = b === 0x0d ? 1 : 0;
            if (b === 0x0a) {
                if (++lfOnly === 2) {
                    split = i + 1;
                    break;
                }
            } else lfOnly = 0;
        }
        if (split < 0) {
            queuedLen += chunk.length;
            if (queuedLen > MAX_HEADER_BYTES)
                throw new Error(`multipart header exceeded ${MAX_HEADER_BYTES} bytes without terminator`);
            queued.push(chunk);
            continue;
        }
        const headerPart = chunk.subarray(0, split);
        const rest = chunk.subarray(split);
        if (queuedLen + headerPart.length > MAX_HEADER_BYTES)
            throw new Error(`multipart header exceeded ${MAX_HEADER_BYTES} bytes`);
        queued.push(headerPart);
        if (rest.length) readable.unshift(rest);
        return queued.length === 1 ? queued[0] : Buffer.concat(queued);
    }
}
