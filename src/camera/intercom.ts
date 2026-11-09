import crypto from 'crypto';
import { ClientRequest } from 'http';
import https from 'https';
import net from 'net';
import { PassThrough } from 'stream';
import { kasaControlAuth } from './http';

export const KASA_TALK_PORT = 18443;
const KASA_TALK_PATH = '/https/speaker/audio/g711block';
const TALK_BOUNDARY = 'audio-boundary--';

// The Kasa app sends X-APP-ID/playerId of the form "tty.<32 base64-ish chars>". The token
// looks app-generated (not negotiated with the camera), so we mint our own per-session.
function generatePlayerId(): string {
    return 'tty.' + crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, 32);
}

function partHeader(contentType: string, length: number): Buffer {
    return Buffer.from(`--${TALK_BOUNDARY}\r\nContent-Length: ${length}\r\nContent-Type: ${contentType}\r\n\r\n`);
}
const PART_TRAILER = Buffer.from('\r\n');
// An empty part; the app sends one about every 3 s to keep the connection alive during silence.
const HEARTBEAT_PART = Buffer.concat([partHeader('audio/heartbeat', 0), PART_TRAILER]);

export interface KasaTalkOptions {
    ip: string;
    port?: number;
    username: string;
    password: string;
    console?: Console;
}

// One ongoing POST per talk session. Multipart parts wrap raw G.711 µ-law audio blocks
// (Content-Type: audio/g711u) interleaved with empty audio/heartbeat parts that the app
// uses to keep the connection alive during silence (~one every 3 s). The body is chunked
// transfer encoded; the request never completes until the session is closed.
export class KasaTalkSession {
    private request?: ClientRequest;
    private body = new PassThrough();
    private playerId = '';
    private heartbeatTimer?: NodeJS.Timeout;
    private closed = false;
    private closeCallbacks?: (() => void)[] = [];
    // Audio blocks all have the same size, so their part header is built once and reused.
    private audioHeader?: { length: number; header: Buffer };

    constructor(public options: KasaTalkOptions) {}

    async start(): Promise<void> {
        this.playerId = generatePlayerId();
        const port = this.options.port || KASA_TALK_PORT;
        const auth = kasaControlAuth(this.options.username, this.options.password);

        const search = new URLSearchParams({ playerId: this.playerId });

        const req = https.request({
            host: this.options.ip,
            port,
            method: 'POST',
            path: `${KASA_TALK_PATH}?${search.toString()}`,
            rejectUnauthorized: false,
            headers: {
                Authorization: auth,
                'X-APP-ID': this.playerId,
                'Content-Type': `multipart/x-mixed-replace;boundary=${TALK_BOUNDARY}`,
                'Transfer-Encoding': 'chunked',
                Connection: 'keep-alive',
                Accept: '*/*',
            },
        });

        this.request = req;

        // Disable Nagle on the underlying TCP socket as soon as it's available. Each 20 ms
        // audio part we write is small (~230 B) and fewer than the segment size, so Nagle
        // would coalesce parts waiting for an ACK or for the 200 ms deadline — adding
        // user-perceptible chunkiness on top of the inherent network round-trip. The talk
        // session is a constant low-rate stream, exactly the workload Nagle hurts.
        //
        // Cover both timings: the default https.Agent pools connections and may assign a
        // pooled socket synchronously inside https.request(), in which case `'socket'`
        // already fired by the time we get here and our once-listener would never run.
        // Check `req.socket` immediately, and otherwise register a once-listener for the
        // fresh-connection path.
        const setSocketNoDelay = (socket: net.Socket) => socket.setNoDelay(true);
        if (req.socket) setSocketNoDelay(req.socket as net.Socket);
        else req.once('socket', setSocketNoDelay);

        req.on('error', e => {
            // Suppress when the close came first (deliberate teardown via close()): ending
            // the body mid-flight makes the in-flight HTTPS request emit "socket hang up"
            // one tick later, which isn't a real error.
            if (!this.closed) this.options.console?.warn('kasa talk request error', e.message);
            this.close();
        });

        req.on('response', res => {
            this.options.console?.log(`kasa talk response: ${res.statusCode}`);
            res.on('data', () => {
                /* drain */
            });
            res.on('end', () => this.close());
        });

        // Body is a PassThrough so we can write parts incrementally; pipe it into the request.
        this.body.pipe(req);

        // Heartbeat immediately + every 3 s, mirroring the Kasa app's idle pattern.
        this.write(HEARTBEAT_PART);
        this.heartbeatTimer = setInterval(() => this.write(HEARTBEAT_PART), 3000);
    }

    // Returns false when the underlying stream is asking for backpressure (Node's standard
    // contract). Caller should pause its source until `drain` fires on `body`. We surface
    // this so an unhealthy/slow camera socket can't grow the PassThrough buffer without bound.
    writeAudio(chunk: Buffer): boolean {
        if (!chunk.length) return true;
        if (this.audioHeader?.length !== chunk.length)
            this.audioHeader = { length: chunk.length, header: partHeader('audio/g711u', chunk.length) };
        const { header } = this.audioHeader;
        // Header + body + CRLF in one write. Three separate writes would each become its own
        // chunked-encoding chunk on the HTTP body and (worse) its own TLS record + TCP segment.
        // Cameras and Node's HTTP/TLS stack both prefer one part arriving as one segment —
        // fewer per-packet ACKs and no risk of the camera partially parsing a part header
        // before the body lands.
        return this.write(
            Buffer.concat([header, chunk, PART_TRAILER], header.length + chunk.length + PART_TRAILER.length),
        );
    }

    onDrain(cb: () => void): void {
        this.body.once('drain', cb);
    }

    // Subscribe to the session's teardown event. If the session is already closed, the
    // callback is invoked on the next microtask so callers don't have to special-case timing.
    onClose(cb: () => void): void {
        if (this.closed) {
            queueMicrotask(cb);
            return;
        }
        this.closeCallbacks!.push(cb);
    }

    private write(part: Buffer): boolean {
        if (this.closed) return true;
        return this.body.write(part);
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.heartbeatTimer);
        try {
            this.body.end();
        } catch {}
        try {
            this.request?.end();
        } catch {}
        const cbs = this.closeCallbacks;
        // Drop the array reference before invoking callbacks so V8 can reclaim it; any
        // late onClose() registration after this point will be served via queueMicrotask.
        this.closeCallbacks = undefined;
        if (cbs) {
            for (const cb of cbs) {
                try {
                    cb();
                } catch (e) {
                    this.options.console?.warn('kasa talk onClose handler threw', e);
                }
            }
        }
    }
}
