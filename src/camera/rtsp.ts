import { randomBytes } from 'crypto';
import net from 'net';

const RTSP_INTERLEAVED_MAGIC = 0x24; // '$'

export interface RtspChannelPair {
    rtp: number;
    rtcp: number;
}

export interface RtspChannels {
    video: RtspChannelPair;
    audio: RtspChannelPair;
}

export interface RtspSendInterleaved {
    (channel: number, packet: Buffer): boolean;
}

export interface RtspHandlerOptions {
    sdp: string;
    onPlay: (send: RtspSendInterleaved, channels: RtspChannels) => void;
    onTeardown: () => void;
    console: Console;
}

interface RtspRequest {
    method: string;
    uri: string;
    headers: Map<string, string>;
}

// Minimal RTSP server-side handler for ONE TCP client. Supports the methods Scrypted (and
// any standard RTSP client) actually uses: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN.
// TCP-interleaved transport only — that's what Scrypted's pipeline asks for by default and
// it sidesteps every NAT/UDP-loss complication. We build the SDP upstream and just serve it
// on DESCRIBE; we never parse one.
export function handleRtspClient(client: net.Socket, opts: RtspHandlerOptions): void {
    const sessionId = randomBytes(8).toString('hex');
    let videoChannels: RtspChannelPair | undefined;
    let audioChannels: RtspChannelPair | undefined;
    let buffered: Buffer = Buffer.alloc(0);
    let isPlaying = false;
    let teardownNotified = false;

    const notifyTeardown = () => {
        if (teardownNotified) return;
        teardownNotified = true;
        opts.onTeardown();
    };

    const send: RtspSendInterleaved = (channel, packet) => {
        if (client.destroyed) return false;
        // Interleaved frame: '$' + 1-byte channel + 2-byte BE length + RTP packet bytes.
        // Header + body in one Buffer to avoid splitting writes (a small write between the
        // two would let an out-of-order chunk arrive in the middle of an interleaved frame).
        const out = Buffer.allocUnsafe(4 + packet.length);
        out[0] = RTSP_INTERLEAVED_MAGIC;
        out[1] = channel;
        out.writeUInt16BE(packet.length, 2);
        packet.copy(out, 4);
        // The destroyed check above is racy — the socket can be torn down between the
        // check and write (different microtask), in which case write throws
        // ERR_STREAM_DESTROYED. Catch it; the next packet's destroyed check will gate
        // further sends.
        try {
            return client.write(out);
        } catch {
            return false;
        }
    };

    const respond = (
        cseq: string,
        status: number,
        statusText: string,
        headers: Record<string, string | number> = {},
        body?: string,
    ) => {
        const lines = [`RTSP/1.0 ${status} ${statusText}`, `CSeq: ${cseq}`];
        if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
        for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
        const message = lines.join('\r\n') + '\r\n\r\n' + (body || '');
        client.write(message);
    };

    const handleRequest = (req: RtspRequest) => {
        const cseq = req.headers.get('cseq') || '0';
        switch (req.method) {
            case 'OPTIONS':
                respond(cseq, 200, 'OK', {
                    Public: 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN',
                });
                return;

            case 'DESCRIBE':
                respond(cseq, 200, 'OK', { 'Content-Type': 'application/sdp' }, opts.sdp);
                return;

            case 'SETUP': {
                const transport = req.headers.get('transport') || '';
                const m = /interleaved=(\d+)-(\d+)/i.exec(transport);
                if (!m) {
                    // We only support TCP-interleaved transport. UDP would require allocating
                    // server-side ports, parsing client_port, and sending RTP via dgram —
                    // pointless for a localhost-only stream.
                    respond(cseq, 461, 'Unsupported Transport');
                    return;
                }
                const rtp = parseInt(m[1], 10);
                const rtcp = parseInt(m[2], 10);
                const trackMatch = req.uri.match(/trackID=(\d+)/i);
                const trackId = trackMatch ? parseInt(trackMatch[1], 10) : -1;
                if (trackId === 0) videoChannels = { rtp, rtcp };
                else if (trackId === 1) audioChannels = { rtp, rtcp };
                else {
                    respond(cseq, 404, 'Not Found');
                    return;
                }
                respond(cseq, 200, 'OK', { Transport: transport, Session: sessionId });
                return;
            }

            case 'PLAY':
                if (!videoChannels || !audioChannels) {
                    respond(cseq, 412, 'Precondition Failed');
                    return;
                }
                respond(cseq, 200, 'OK', { Session: sessionId, Range: 'npt=0.000-' });
                if (!isPlaying) {
                    isPlaying = true;
                    try {
                        opts.onPlay(send, { video: videoChannels, audio: audioChannels });
                    } catch (e) {
                        opts.console.warn('rtsp onPlay handler error', e);
                        client.destroy();
                    }
                }
                return;

            case 'PAUSE':
                respond(cseq, 200, 'OK', { Session: sessionId });
                return;

            case 'TEARDOWN':
                respond(cseq, 200, 'OK', { Session: sessionId });
                client.end();
                return;

            default:
                respond(cseq, 405, 'Method Not Allowed');
        }
    };

    const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');
    // Caps on accumulated buffer size. Server is localhost-only, but a misbehaving or
    // malicious client could trickle bytes without ever sending the header terminator,
    // or advertise a giant Content-Length, forcing `buffered` to grow unbounded via
    // Buffer.concat. Real RTSP requests for the methods we accept are well under 1 KB.
    const RTSP_MAX_HEADER_BYTES = 8 * 1024;
    const RTSP_MAX_BODY_BYTES = 4 * 1024;
    client.on('data', (chunk: Buffer) => {
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
        // Parse messages until we run out of complete ones in the buffer.
        while (buffered.length > 0) {
            // Skip any interleaved frames the client might send back at us. (Standard
            // clients don't, but defending against the bidirectional channel costs nothing
            // and is robust against odd consumers that probe.)
            if (buffered[0] === RTSP_INTERLEAVED_MAGIC) {
                if (buffered.length < 4) return;
                const len = buffered.readUInt16BE(2);
                if (buffered.length < 4 + len) return;
                buffered = buffered.subarray(4 + len);
                continue;
            }
            const headerEndIdx = buffered.indexOf(HEADER_TERMINATOR);
            if (headerEndIdx < 0) {
                if (buffered.length > RTSP_MAX_HEADER_BYTES) {
                    opts.console.warn('rtsp: header section exceeded cap, dropping client');
                    client.destroy();
                }
                return;
            }
            const headerStr = buffered.subarray(0, headerEndIdx).toString('utf8');
            const headerLines = headerStr.split('\r\n');
            const requestLine = headerLines.shift() || '';
            const [method, uri] = requestLine.split(' ');
            // Map (not a plain object) so a malicious peer can't reach Object.prototype via
            // a crafted header name like `__proto__`. Practical risk is tiny — the server
            // only listens on localhost — but Map is the pattern CodeQL accepts.
            const headers = new Map<string, string>();
            for (const line of headerLines) {
                const colon = line.indexOf(':');
                if (colon < 0) continue;
                headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
            }
            const contentLength = parseInt(headers.get('content-length') || '0', 10);
            if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > RTSP_MAX_BODY_BYTES) {
                opts.console.warn('rtsp: invalid or oversized content-length', headers.get('content-length'));
                client.destroy();
                return;
            }
            const totalLen = headerEndIdx + HEADER_TERMINATOR.length + contentLength;
            if (buffered.length < totalLen) return;
            // We currently ignore request bodies — none of the methods we handle need one.
            buffered = buffered.subarray(totalLen);
            if (!method || !uri) {
                opts.console.warn('rtsp: malformed request line', JSON.stringify(requestLine));
                client.destroy();
                return;
            }
            try {
                handleRequest({ method: method.toUpperCase(), uri, headers });
            } catch (e) {
                opts.console.warn('rtsp handleRequest threw', e);
                client.destroy();
                return;
            }
        }
    });

    client.on('close', notifyTeardown);
    client.on('error', notifyTeardown);
}
