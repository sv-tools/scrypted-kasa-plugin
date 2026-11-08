import crypto from 'crypto';
import https from 'https';
import { xorDecryptInPlace, xorEncryptInPlace } from '../shared/cipher';

export const KASA_LINKIE_PORT = 10443;
const KASA_LINKIE_PATH = '/data/LINKIE2.json';
const KASA_LINKIE_TIMEOUT_MS = 5000;

// Same auth quirk as the talk channel: the camera wants md5_hex(plaintext) as the password.
// (The receive endpoint takes base64(plaintext) instead — same camera, three different
// places, three subtly different conventions.)
function md5Hex(plaintext: string): string {
    return crypto.createHash('md5').update(plaintext, 'utf8').digest('hex');
}

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

export class KasaLinkieClient {
    constructor(
        public options: KasaLinkieOptions,
        public logger?: KasaLinkieClientLogger,
    ) {}

    async call(command: Record<string, any>): Promise<any> {
        const body = {
            ...command,
            context: { source: crypto.randomUUID() },
        };
        const json = JSON.stringify(body);
        // Encrypt in-place: the Buffer.from we just allocated isn't shared anywhere else.
        const encrypted = xorEncryptInPlace(Buffer.from(json, 'utf8'));
        const formBody = Buffer.from(`content=${encodeURIComponent(encrypted.toString('base64'))}`);

        // Send Basic auth pre-emptively. The camera does not respond at all to unauthenticated
        // requests (no 401, no anything), so the standard "wait for challenge then retry"
        // pattern would just hang. Pre-emptive auth matches what curl with `-u` does.
        const auth =
            'Basic ' + Buffer.from(`${this.options.username}:${md5Hex(this.options.password)}`).toString('base64');

        const respBuffer = await new Promise<Buffer>((resolve, reject) => {
            const req = https.request(
                {
                    host: this.options.ip,
                    port: this.options.port || KASA_LINKIE_PORT,
                    method: 'POST',
                    path: KASA_LINKIE_PATH,
                    rejectUnauthorized: false,
                    // Mirror the Kasa iOS app's headers — the camera gates /data/LINKIE2.json on the
                    // User-Agent (silently drops requests that don't look like the Kasa app).
                    headers: {
                        Authorization: auth,
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
            req.on('error', reject);
            req.write(formBody);
            req.end();
        });

        const respB64 = respBuffer.toString('utf8').trim();
        // Same here: the base64-decoded buffer is freshly ours, decrypt in-place.
        const respDecrypted = xorDecryptInPlace(Buffer.from(respB64, 'base64'));
        return JSON.parse(respDecrypted.toString('utf8'));
    }

    // Spotlight controls under smartlife.cam.ipcamera.dayNight (called "force_lamp" at the
    // protocol level, "spotlight" in the Kasa app UI).
    // Returns 'on' / 'off' for cameras that support it, undefined for cameras that don't
    // (request fails or the module is missing from the response).

    async getForceLampState(): Promise<'on' | 'off' | undefined> {
        try {
            const r = await this.call({
                'smartlife.cam.ipcamera.dayNight': { get_force_lamp_state: {} },
            });
            const v = r?.['smartlife.cam.ipcamera.dayNight']?.get_force_lamp_state?.value;
            return v === 'on' || v === 'off' ? v : undefined;
        } catch (e) {
            this.logger?.warn?.('kasa linkie get_force_lamp_state failed:', (e as Error).message);
            return undefined;
        }
    }

    async setForceLampState(on: boolean): Promise<void> {
        const r = await this.call({
            'smartlife.cam.ipcamera.dayNight': {
                set_force_lamp_state: { value: on ? 'on' : 'off' },
            },
        });
        const errCode = r?.['smartlife.cam.ipcamera.dayNight']?.set_force_lamp_state?.err_code;
        if (errCode !== 0) throw new Error(`set_force_lamp_state err_code=${errCode}`);
    }

    // Status LED on the camera body, controlled via smartlife.cam.ipcamera.led. Used to
    // back HomeKit's CameraOperatingModeIndicator characteristic via OnOff on the camera.

    async getLedStatus(): Promise<'on' | 'off' | undefined> {
        try {
            const r = await this.call({
                'smartlife.cam.ipcamera.led': { get_status: {} },
            });
            const v = r?.['smartlife.cam.ipcamera.led']?.get_status?.value;
            return v === 'on' || v === 'off' ? v : undefined;
        } catch (e) {
            this.logger?.warn?.('kasa linkie get_status (led) failed:', (e as Error).message);
            return undefined;
        }
    }

    async setLedStatus(on: boolean): Promise<void> {
        const r = await this.call({
            'smartlife.cam.ipcamera.led': {
                set_status: { value: on ? 'on' : 'off' },
            },
        });
        const errCode = r?.['smartlife.cam.ipcamera.led']?.set_status?.err_code;
        if (errCode !== 0) throw new Error(`led set_status err_code=${errCode}`);
    }

    // Siren under smartlife.cam.ipcamera.siren. The camera auto-stops after the duration
    // configured in the Kasa app (default 30 s); we just send on/off and let the camera
    // handle the timer.

    async getSirenState(): Promise<'on' | 'off' | undefined> {
        try {
            const r = await this.call({
                'smartlife.cam.ipcamera.siren': { get_state: {} },
            });
            const v = r?.['smartlife.cam.ipcamera.siren']?.get_state?.value;
            return v === 'on' || v === 'off' ? v : undefined;
        } catch (e) {
            this.logger?.warn?.('kasa linkie get_state (siren) failed:', (e as Error).message);
            return undefined;
        }
    }

    async setSirenState(on: boolean): Promise<void> {
        const r = await this.call({
            'smartlife.cam.ipcamera.siren': {
                set_state: { value: on ? 'on' : 'off' },
            },
        });
        const errCode = r?.['smartlife.cam.ipcamera.siren']?.set_state?.err_code;
        if (errCode !== 0) throw new Error(`siren set_state err_code=${errCode}`);
    }

    // Pan/tilt under smartlife.cam.ipcamera.ptz (KC410S "Spot Pan Tilt" and siblings).
    // Fixed-lens models answer every ptz method with -10008 "Unsupported API call", so a
    // successful get_capability doubles as the feature probe.

    async getPtzCapability(): Promise<KasaPtzCapability | undefined> {
        try {
            const r = await this.call({
                'smartlife.cam.ipcamera.ptz': { get_capability: {} },
            });
            const v = r?.['smartlife.cam.ipcamera.ptz']?.get_capability;
            if (v?.err_code !== 0 || typeof v.max_x !== 'number' || typeof v.max_y !== 'number') return undefined;
            return { maxX: v.max_x, maxY: v.max_y };
        } catch (e) {
            this.logger?.warn?.('kasa linkie get_capability (ptz) failed:', (e as Error).message);
            return undefined;
        }
    }

    async getPtzPresets(): Promise<KasaPtzPreset[]> {
        try {
            const r = await this.call({
                'smartlife.cam.ipcamera.ptz': { get_all_preset: {} },
            });
            const v = r?.['smartlife.cam.ipcamera.ptz']?.get_all_preset;
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
            this.logger?.warn?.('kasa linkie get_all_preset (ptz) failed:', (e as Error).message);
            return [];
        }
    }

    // `speed` is the step size, not a rate: each call moves one discrete step (1 ≈ 50 units,
    // 10 ≈ 333 units on the tilt axis) and the camera stops on its own. 0 or >10 is rejected.
    async ptzMove(direction: KasaPtzDirection, speed: number): Promise<void> {
        const r = await this.call({
            'smartlife.cam.ipcamera.ptz': { set_move: { direction, speed } },
        });
        const errCode = r?.['smartlife.cam.ipcamera.ptz']?.set_move?.err_code;
        // -41203 covers both a bad value and an axis already at its end stop.
        if (errCode !== 0) throw new Error(`ptz set_move ${direction} err_code=${errCode}`);
    }

    async ptzRunToPreset(index: number): Promise<void> {
        const r = await this.call({
            'smartlife.cam.ipcamera.ptz': { set_run_to_preset: { index } },
        });
        const errCode = r?.['smartlife.cam.ipcamera.ptz']?.set_run_to_preset?.err_code;
        if (errCode !== 0) throw new Error(`ptz set_run_to_preset ${index} err_code=${errCode}`);
    }
}
