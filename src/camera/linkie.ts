import crypto from 'crypto';
import https from 'https';
import { xorDecryptInPlace, xorEncryptInPlace } from '../shared/cipher';
import { kasaControlAuth, markStaleSocket, retryStaleSocketOnce } from './http';

export const KASA_LINKIE_PORT = 10443;
const KASA_LINKIE_PATH = '/data/LINKIE2.json';
const KASA_LINKIE_TIMEOUT_MS = 5000;
// Every module this plugin calls lives under this prefix.
const KASA_LINKIE_MODULE_PREFIX = 'smartlife.cam.ipcamera.';

export interface KasaLinkieOptions {
    ip: string;
    port?: number;
    username: string;
    password: string;
}

export interface KasaLinkieClientLogger {
    warn?: Console['warn'];
}

// Speaks the Kasa "LINKIE2" control protocol used by the iOS app for everything that isn't
// streaming or talk: spotlight, siren, mic config, SD card status, etc. Wire format:
//   - HTTPS POST to https://<ip>:10443/data/LINKIE2.json
//   - Body: application/x-www-form-urlencoded `content=<base64(xor_ab(json))>`
//   - Each request body adds a `context.source` UUID — the camera ignores it but the field
//     is always present in captures, so we generate one per call.
//   - Response: same encoding, with the result merged under the same module/method keys.
// Directions accepted by smartlife.cam.ipcamera.ptz.set_move. Matched exactly and
// lowercase; `up`/`down` are rejected with -41203 — the firmware says top/bottom.
export type KasaPtzDirection = 'left' | 'right' | 'top' | 'bottom';

export interface KasaPtzCapability {
    maxX: number;
    maxY: number;
}

export interface KasaPtzPreset {
    index: number;
    name: string;
}

// LINKIE2 error codes, the same on KC410S / KC420WS / KD110 firmware.
// -10008 "Unsupported API call." covers unknown modules as well as unknown methods.
export const KASA_LINKIE_CAMERA_OFF = -40919;

export class KasaLinkieError extends Error {
    constructor(
        message: string,
        public errCode?: number,
    ) {
        super(message);
    }
}

export class KasaLinkieClient {
    // One kept-alive connection per camera. Motion polling calls once a second; reusing the TLS
    // session takes a call from ~500 ms to ~30 ms. maxSockets 1 also queues concurrent callers
    // (a poll racing a settings probe): parallel calls to one camera occasionally drop responses.
    private agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    // Sent pre-emptively: the camera does not respond at all to unauthenticated requests (no
    // 401, no anything), so waiting for a challenge would just hang. Built once; a client is
    // replaced, not edited, when the credentials change.
    private readonly auth: string;

    constructor(
        public readonly options: KasaLinkieOptions,
        public logger?: KasaLinkieClientLogger,
    ) {
        this.auth = kasaControlAuth(options.username, options.password);
    }

    // Closes the kept-alive connection. The socket belongs to the host Node process, so a
    // replaced or released client would otherwise hold it open until the camera drops it.
    destroy(): void {
        this.agent.destroy();
    }

    async call(command: Record<string, any>): Promise<any> {
        const body = {
            ...command,
            context: { source: crypto.randomUUID() },
        };
        const json = JSON.stringify(body);
        // Encrypt in-place: the Buffer.from we just allocated isn't shared anywhere else.
        const encrypted = xorEncryptInPlace(Buffer.from(json, 'utf8'));
        const formBody = Buffer.from(`content=${encodeURIComponent(encrypted.toString('base64'))}`);

        const send = () =>
            new Promise<Buffer>((resolve, reject) => {
                const req = https.request(
                    {
                        host: this.options.ip,
                        port: this.options.port || KASA_LINKIE_PORT,
                        method: 'POST',
                        path: KASA_LINKIE_PATH,
                        agent: this.agent,
                        rejectUnauthorized: false,
                        // Mirror the Kasa iOS app's headers — the camera gates /data/LINKIE2.json on the
                        // User-Agent (silently drops requests that don't look like the Kasa app).
                        headers: {
                            Authorization: this.auth,
                            'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                            'Content-Length': formBody.length,
                            'User-Agent': 'Kasa/1752 CFNetwork/3860.500.112 Darwin/25.4.0',
                            Accept: '*/*',
                            'Accept-Language': 'en-US,en;q=0.9',
                            // We don't decompress responses (camera never sends compressed today, but
                            // advertising 'gzip' would let a future firmware break our base64+XOR decode).
                            'Accept-Encoding': 'identity',
                            Connection: 'keep-alive',
                        },
                    },
                    res => {
                        if (res.statusCode && res.statusCode >= 400) {
                            res.resume();
                            reject(new Error(`kasa linkie HTTP ${res.statusCode}`));
                            return;
                        }
                        const chunks: Buffer[] = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => resolve(Buffer.concat(chunks)));
                        res.on('error', reject);
                    },
                );
                req.setTimeout(KASA_LINKIE_TIMEOUT_MS, () => {
                    req.destroy(new Error(`kasa linkie request timeout after ${KASA_LINKIE_TIMEOUT_MS}ms`));
                });
                req.on('error', e => reject(markStaleSocket(req, e)));
                req.write(formBody);
                req.end();
            });
        const respBuffer = await retryStaleSocketOnce(send);

        const respB64 = respBuffer.toString('utf8').trim();
        // Same here: the base64-decoded buffer is freshly ours, decrypt in-place.
        const respDecrypted = xorDecryptInPlace(Buffer.from(respB64, 'base64'));
        return JSON.parse(respDecrypted.toString('utf8'));
    }

    // Calls one method of one module and returns that method's result object.
    private async invoke(module: string, method: string, args: Record<string, any> = {}): Promise<any> {
        const key = KASA_LINKIE_MODULE_PREFIX + module;
        const r = await this.call({ [key]: { [method]: args } });
        return r?.[key]?.[method];
    }

    // Reads an on/off value. Doubles as the feature probe: undefined means the camera doesn't
    // have the feature (the module is missing from the response) or didn't answer.
    private async getState(module: string, method: string, quiet = false): Promise<'on' | 'off' | undefined> {
        try {
            const v = (await this.invoke(module, method))?.value;
            return v === 'on' || v === 'off' ? v : undefined;
        } catch (e) {
            if (!quiet) this.logger?.warn?.(`kasa linkie ${module} ${method} failed:`, (e as Error).message);
            return undefined;
        }
    }

    private async command(module: string, method: string, args: Record<string, any> = {}): Promise<void> {
        const errCode = (await this.invoke(module, method, args))?.err_code;
        if (errCode === 0) return;
        // The arguments say which call it was (e.g. which PTZ direction hit its end stop).
        const sent = Object.keys(args).length ? ` ${JSON.stringify(args)}` : '';
        throw new KasaLinkieError(`${module} ${method}${sent} err_code=${errCode}`, errCode);
    }

    private setState(module: string, method: string, on: boolean): Promise<void> {
        return this.command(module, method, { value: on ? 'on' : 'off' });
    }

    // Spotlight, under dayNight (called "force_lamp" at the protocol level, "spotlight" in the
    // Kasa app UI).
    getForceLampState(): Promise<'on' | 'off' | undefined> {
        return this.getState('dayNight', 'get_force_lamp_state');
    }

    setForceLampState(on: boolean): Promise<void> {
        return this.setState('dayNight', 'set_force_lamp_state', on);
    }

    // Status LED on the camera body. Backs HomeKit's CameraOperatingModeIndicator
    // characteristic via OnOff on the camera.
    getLedStatus(): Promise<'on' | 'off' | undefined> {
        return this.getState('led', 'get_status');
    }

    setLedStatus(on: boolean): Promise<void> {
        return this.setState('led', 'set_status', on);
    }

    // Siren. The camera auto-stops after the duration configured in the Kasa app (default
    // 30 s); we just send on/off and let the camera handle the timer.
    getSirenState(): Promise<'on' | 'off' | undefined> {
        return this.getState('siren', 'get_state');
    }

    setSirenState(on: boolean): Promise<void> {
        return this.setState('siren', 'set_state', on);
    }

    // The camera's own on/off ("camera off" in the Kasa app), under switch. Off stops video for
    // every client, not just HomeKit: the stream port stays open but answers HTTP 503 until
    // it's turned back on, and the next stream attempt after that succeeds.
    // `quiet` leaves a failed call unlogged, for a caller that already reported the outage.
    getCameraEnabled(quiet = false): Promise<'on' | 'off' | undefined> {
        return this.getState('switch', 'get_is_enable', quiet);
    }

    setCameraEnabled(on: boolean): Promise<void> {
        return this.setState('switch', 'set_is_enable', on);
    }

    // Reboot, under system. Found by probing (not in any published client): `reboot` answers
    // -10008, `set_reboot` is the real one. The camera drops off the network ~20 s later and is
    // back with all ports open after ~30 s. Useful when the stream server on :19443 dies while
    // the control plane stays up (connection refused on stream only) — that state otherwise
    // needs a power cycle.
    reboot(): Promise<void> {
        return this.command('system', 'set_reboot');
    }

    // Pan/tilt, under ptz (KC410S "Spot Pan Tilt" and siblings). Fixed-lens models answer every
    // ptz method with -10008 "Unsupported API call", so a successful get_capability doubles as
    // the feature probe.
    async getPtzCapability(): Promise<KasaPtzCapability | undefined> {
        try {
            const v = await this.invoke('ptz', 'get_capability');
            if (v?.err_code !== 0 || typeof v.max_x !== 'number' || typeof v.max_y !== 'number') return undefined;
            return { maxX: v.max_x, maxY: v.max_y };
        } catch (e) {
            this.logger?.warn?.('kasa linkie ptz get_capability failed:', (e as Error).message);
            return undefined;
        }
    }

    async getPtzPresets(): Promise<KasaPtzPreset[]> {
        try {
            const v = await this.invoke('ptz', 'get_all_preset');
            if (v?.err_code !== 0 || !Array.isArray(v.preset_attr)) return [];
            // Entry shape isn't documented anywhere we've found. set_run_to_preset takes a
            // 1-based index (the Kasa app's "viewpoint" number), so fall back to position when
            // an entry doesn't carry its own index.
            return v.preset_attr.map((p: any, i: number) => {
                const index = typeof p?.index === 'number' ? p.index : i + 1;
                const name = typeof p?.name === 'string' && p.name.trim() ? p.name : `Viewpoint ${index}`;
                return { index, name };
            });
        } catch (e) {
            this.logger?.warn?.('kasa linkie ptz get_all_preset failed:', (e as Error).message);
            return [];
        }
    }

    // `speed` is the step size, not a rate: each call moves one discrete step (1 ≈ 50 units,
    // 10 ≈ 333 units on the tilt axis) and the camera stops on its own. 0 or >10 is rejected
    // with -41203, which also covers an axis already at its end stop.
    ptzMove(direction: KasaPtzDirection, speed: number): Promise<void> {
        return this.command('ptz', 'set_move', { direction, speed });
    }

    ptzRunToPreset(index: number): Promise<void> {
        return this.command('ptz', 'set_run_to_preset', { index });
    }

    // The camera's own motion detection, under vod. The firmware wants `timestamp` (Unix
    // seconds, after 2019-05-01) directly in the method object, and reports a missing one as
    // "The parameter [start_time] is required." (-40700), which is misleading.
    // is_moving is true while an alarm fired within the last ~2 s: motion, person, baby cry, or a
    // doorbell ring (sound alarms excluded). There is no push or long-poll; callers poll.
    // The timestamp only feeds the SD-recording flags (is_video_ready / is_event_finish).
    async getMotionDetected(): Promise<boolean> {
        const v = await this.invoke('vod', 'get_detect_event_state', { timestamp: Math.floor(Date.now() / 1000) });
        if (v?.err_code !== 0)
            throw new KasaLinkieError(
                `vod get_detect_event_state err_code=${v?.err_code} ${v?.err_msg || ''}`,
                v?.err_code,
            );
        return v.is_moving === true;
    }
}
