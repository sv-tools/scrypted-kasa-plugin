import crypto from 'crypto';
import type { ClientRequest } from 'http';

// Every camera endpoint takes HTTP Basic auth with the Kasa account email and an encoded form
// of the account password, and the encoding differs per endpoint. They are kept side by side
// here so the difference stays visible; each endpoint rejects the other's encoding.
function basicAuth(username: string, encodedPassword: string): string {
    return 'Basic ' + Buffer.from(`${username}:${encodedPassword}`).toString('base64');
}

// Stream and snapshot (:19443): base64(plaintext).
export function kasaStreamAuth(username: string, password: string): string {
    return basicAuth(username, Buffer.from(password, 'utf8').toString('base64'));
}

// Talk (:18443) and LINKIE2 control (:10443): md5_hex(plaintext). Observed on KC420WS firmware
// 2.3.26 via mitmproxy capture of the official Kasa iOS app.
export function kasaControlAuth(username: string, password: string): string {
    return basicAuth(username, crypto.createHash('md5').update(password, 'utf8').digest('hex'));
}

// A request can fail on a reused kept-alive socket that the camera closed while it sat idle;
// Node only learns that on the next write. Mark that error where the request fails, and send
// the request once more where it was sent.
const STALE_SOCKET = Symbol('staleSocket');

export function markStaleSocket(req: ClientRequest, e: Error): Error {
    const code = (e as NodeJS.ErrnoException).code;
    if (req.reusedSocket && (code === 'ECONNRESET' || code === 'EPIPE')) (e as any)[STALE_SOCKET] = true;
    return e;
}

export function retryStaleSocketOnce<T>(send: () => Promise<T>): Promise<T> {
    return send().catch(e => {
        if (!e?.[STALE_SOCKET]) throw e;
        return send();
    });
}
