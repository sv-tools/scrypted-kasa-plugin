import sdk, {
    AdoptDevice,
    Device,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceDiscovery,
    DeviceProvider,
    DiscoveredDevice,
    FFmpegInput,
    Intercom,
    MediaObject,
    OnOff,
    Readme,
    RequestMediaStreamOptions,
    ResponseMediaStreamOptions,
    ScryptedDeviceBase,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
    ScryptedNativeId,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import child_process, { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { KASA_DEFAULT_PORT, KasaClient } from './camera/api';
import { KASA_TALK_PORT, KasaTalkSession } from './camera/intercom';
import { KasaLinkieClient } from './camera/linkie';
import { KasaStreamHandle, registerLiveCleanup, spawnKasaStream } from './camera/stream';
import { KasaBulb } from './iot/bulb';
import { KasaDimmer } from './iot/dimmer';
import { KasaPlug } from './iot/plug';
import { KASA_IOT_PORT } from './iot/protocol';
import { KasaSwitch } from './iot/switch';
import { discoverKasa, KasaDiscoveredDevice } from './shared/discovery';
import { formatKasaMac, renderKv } from './shared/readme';

// G.711 µ-law packetization: 8000 samples/sec * 1 byte/sample = 160 bytes/20ms.
// 20 ms is the standard RTP packetization for PCMU and matches what the Kasa app appears
// to use for its uplink chunks during active talk.
const TALK_CHUNK_BYTES = 160;

// Models in this set are TP-Link Kasa cameras (sysinfo.type === 'IOT.IPCAMERA' is the primary
// filter; this is a defense-in-depth allowlist for ambiguous replies).
const KASA_CAMERA_TYPES = new Set(['IOT.IPCAMERA']);

// Promise wrapper with externally-callable resolve/reject. Used here as a kill switch for
// camera streaming: any teardown source resolves it once and every owned resource registers
// a cleanup against the same promise.
class Deferred<T> {
    finished = false;
    resolve!: (value: T) => void;
    reject!: (error: Error) => void;
    promise: Promise<T>;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = v => {
                this.finished = true;
                resolve(v);
            };
            this.reject = e => {
                this.finished = true;
                reject(e);
            };
        });
    }
}

// All values stored under the `kasaClass` storage key live in this union. classifyKasa()
// only returns the four families that auto-discovery can detect from sysinfo; 'dimmer' is
// added by adoptIotDevice() when the device exposes brightness, and the manual 'Add device'
// dialog can persist any of the five.
type KasaDeviceClass = 'camera' | 'plug' | 'switch' | 'dimmer' | 'bulb';

// Classify a discovered device by its sysinfo. Returns undefined for device families we
// don't model (e.g. multi-outlet plug strips, hubs).
function classifyKasa(d: KasaDiscoveredDevice): KasaDeviceClass | undefined {
    if (KASA_CAMERA_TYPES.has(d.type)) return 'camera';
    if (d.type === 'IOT.SMARTBULB') return 'bulb';
    if (d.type === 'IOT.SMARTPLUGSWITCH') {
        // The Kasa app distinguishes outlets from light switches by `dev_name` /
        // `description`. HS200/210/220 are wall-mounted switches; everything else is an
        // outlet. Multi-outlet strips have a `children` array and are skipped — they need
        // per-outlet handling we don't do yet.
        if (Array.isArray((d.sysinfo as any)?.children) && (d.sysinfo as any).children.length) return undefined;
        const devName: string = (d.sysinfo as any)?.dev_name || '';
        if (/switch|dimmer/i.test(devName)) return 'switch';
        return 'plug';
    }
    return undefined;
}

function isDimmer(d: KasaDiscoveredDevice): boolean {
    const sys = d.sysinfo as any;
    if (typeof sys?.brightness === 'number') return true;
    const feature: string = sys?.feature || '';
    if (/DIM/.test(feature)) return true;
    // KS230 (3-way dimmer) doesn't report `brightness` in sysinfo at idle, and its
    // `feature` string doesn't include DIM either — but `dev_name` always says "Dimmer".
    const devName: string = sys?.dev_name || '';
    return /dimmer/i.test(devName);
}

interface BulbCapabilities {
    isColor: boolean;
    isVariableColorTemp: boolean;
}

function bulbCapabilities(d: KasaDiscoveredDevice): BulbCapabilities {
    const sys = d.sysinfo as any;
    return {
        isColor: sys?.is_color === 1,
        isVariableColorTemp: sys?.is_variable_color_temp === 1,
    };
}

const { deviceManager, mediaManager, systemManager } = sdk;

// Walk every known device's state to collect existing room names. Used to populate the room
// dropdown so the user picks an existing room instead of typing a new one. Cached for 2 s so
// rapid back-to-back calls (Scrypted's UI sometimes re-fetches on every render of the Add
// Device dialog) don't repeatedly walk the entire system state, which can be hundreds of KB.
let knownRoomsCache: { rooms: string[]; at: number } | undefined;
function getKnownRooms(): string[] {
    const now = Date.now();
    if (knownRoomsCache && now - knownRoomsCache.at < 2000) return knownRoomsCache.rooms;
    const rooms = new Set<string>();
    const states = systemManager.getSystemState();
    for (const id of Object.keys(states)) {
        const room = states[id]?.room?.value;
        if (typeof room === 'string' && room.trim()) rooms.add(room.trim());
    }
    const out = [...rooms].sort((a, b) => a.localeCompare(b));
    knownRoomsCache = { rooms: out, at: now };
    return out;
}

// Child device for cameras with a spotlight (e.g. KC420WS — the Kasa app calls this
// the "spotlight"). Backed by the LINKIE2 `smartlife.cam.ipcamera.dayNight.set_force_lamp_state`
// command. (The protocol-level name is "force_lamp" — internally the camera firmware
// treats this as a generic forced-lamp state, but in the user-facing UI it's a spotlight.)
class KasaCameraSpotlight extends ScryptedDeviceBase implements OnOff {
    constructor(
        public camera: KasaCamera,
        nativeId: string,
    ) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.camera.linkie().setForceLampState(true);
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.camera.linkie().setForceLampState(false);
        this.on = false;
    }
}

// Child device for the siren. Backed by smartlife.cam.ipcamera.siren.set_state. The
// camera auto-stops after the duration set in the Kasa app (default 30 s), so the `on`
// state shown in Scrypted may not reflect that auto-off until something polls again.
class KasaCameraSiren extends ScryptedDeviceBase implements OnOff {
    constructor(
        public camera: KasaCamera,
        nativeId: string,
    ) {
        super(nativeId);
    }

    async turnOn(): Promise<void> {
        await this.camera.linkie().setSirenState(true);
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.camera.linkie().setSirenState(false);
        this.on = false;
    }
}

class KasaCamera extends ScryptedDeviceBase implements VideoCamera, Settings, Intercom, DeviceProvider, OnOff, Readme {
    private intercomSession?: KasaTalkSession;
    private intercomFfmpeg?: ChildProcess;
    private spotlight?: KasaCameraSpotlight;
    private siren?: KasaCameraSiren;
    // Kill switches for any in-flight video streams. Stored so we can tear them down when
    // the user changes network/auth settings — otherwise the existing TCP connection keeps
    // talking to the old IP and clients see "phantom" video from a stale endpoint.
    private activeStreamKills = new Set<Deferred<void>>();

    constructor(nativeId: string) {
        super(nativeId);
        // Probe-and-register child devices once settings are available. process.nextTick
        // defers past constructor so storageSettings is fully wired.
        process.nextTick(() =>
            this.refreshChildDevices().catch(e => this.console.warn('refreshChildDevices failed', e)),
        );
    }

    private cachedLinkie?: { client: KasaLinkieClient; ip: string; username: string; password: string };
    linkie(): KasaLinkieClient {
        const { ip, username, password } = this.storageSettings.values;
        // Don't pass storageSettings.port — that's the stream port (19443). LINKIE2 lives
        // on its own fixed port (10443) which the client supplies as a default.
        const c = this.cachedLinkie;
        if (c && c.ip === ip && c.username === username && c.password === password) return c.client;
        const client = new KasaLinkieClient({ ip, username, password }, this.console);
        this.cachedLinkie = { client, ip, username, password };
        return client;
    }

    private get spotlightNativeId(): string {
        return `${this.nativeId}-spotlight`;
    }

    private get sirenNativeId(): string {
        return `${this.nativeId}-siren`;
    }

    // Shared in-flight promise so concurrent triggers (constructor, putSetting,
    // post-adoption) don't run the LINKIE probe loop in parallel against the same camera.
    // The probes are sequential per call; running two in parallel would double the
    // request load and racing onDeviceDiscovered() could re-register children twice.
    private refreshChildDevicesInFlight?: Promise<void>;
    async refreshChildDevices(): Promise<void> {
        if (this.refreshChildDevicesInFlight) return this.refreshChildDevicesInFlight;
        this.refreshChildDevicesInFlight = this.refreshChildDevicesInternal().finally(() => {
            this.refreshChildDevicesInFlight = undefined;
        });
        return this.refreshChildDevicesInFlight;
    }

    private async refreshChildDevicesInternal(): Promise<void> {
        const { ip, username, password } = this.storageSettings.values;
        if (!ip || !username || !password) return;

        const linkie = this.linkie();
        // Probe each capability sequentially. The Kasa iOS app issues LINKIE2 calls
        // serially; firing them in parallel against the same camera occasionally drops
        // responses (likely camera-side request serialization).
        const ledState = await linkie.getLedStatus();
        const lampState = await linkie.getForceLampState();
        const sirenState = await linkie.getSirenState();

        if (ledState !== undefined) this.on = ledState === 'on';

        if (lampState !== undefined) {
            await deviceManager.onDeviceDiscovered({
                nativeId: this.spotlightNativeId,
                name: `${this.name || 'Kasa Camera'} Spotlight`,
                type: ScryptedDeviceType.Light,
                interfaces: [ScryptedInterface.OnOff],
                providerNativeId: this.nativeId,
                // Inherit the camera's room so children show up next to it in the UI.
                // Empty string would clear an existing room assignment, so pass undefined.
                room: this.room || undefined,
            });
            if (!this.spotlight) this.spotlight = new KasaCameraSpotlight(this, this.spotlightNativeId);
            this.spotlight.on = lampState === 'on';
        }

        if (sirenState !== undefined) {
            await deviceManager.onDeviceDiscovered({
                nativeId: this.sirenNativeId,
                name: `${this.name || 'Kasa Camera'} Siren`,
                type: ScryptedDeviceType.Switch,
                interfaces: [ScryptedInterface.OnOff],
                providerNativeId: this.nativeId,
                room: this.room || undefined,
            });
            if (!this.siren) this.siren = new KasaCameraSiren(this, this.sirenNativeId);
            this.siren.on = sirenState === 'on';
        }
    }

    async getDevice(nativeId: string): Promise<any> {
        if (nativeId === this.spotlightNativeId) {
            if (!this.spotlight) this.spotlight = new KasaCameraSpotlight(this, this.spotlightNativeId);
            return this.spotlight;
        }
        if (nativeId === this.sirenNativeId) {
            if (!this.siren) this.siren = new KasaCameraSiren(this, this.sirenNativeId);
            return this.siren;
        }
    }

    async releaseDevice(_id: string, _nativeId: string): Promise<void> {
        // No persistent resources per child to release.
    }

    storageSettings = new StorageSettings(this, {
        ip: {
            title: 'IP Address',
            placeholder: '192.168.1.100',
        },
        port: {
            title: 'Port',
            type: 'number',
            defaultValue: KASA_DEFAULT_PORT,
        },
        username: {
            title: 'Username (Kasa Email)',
            placeholder: 'user@example.com',
            description: 'The TP-Link/Kasa account email associated with the camera.',
        },
        password: {
            title: 'Password (Kasa Account)',
            type: 'password',
            description: 'The TP-Link/Kasa account password.',
        },
    });

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    // Per-camera Readme tab. Surfaces what the user can't easily see otherwise: the
    // firmware/serial the adopted device reports and which HTTPS ports the plugin is
    // talking to (stream / talk / control). Live state (LED on/off, spotlight on/off,
    // motion, ...) is not duplicated here — the device page already shows it live.
    async getReadmeMarkdown(): Promise<string> {
        const info = this.info || {};
        const { ip, port } = this.storageSettings.values;
        const ipLine = ip || info.ip || '?';
        const streamPort = port || KASA_DEFAULT_PORT;
        return [
            `# ${this.name || 'Kasa Camera'}`,
            '',
            '## Device',
            '',
            '```',
            renderKv([
                ['Model', info.model || '?'],
                ['Firmware', info.firmware || '?'],
                ['Serial', info.serialNumber || '?'],
                ['MAC', formatKasaMac(info.mac)],
                ['IP', ipLine],
                ['Stream port', String(streamPort)],
            ]),
            '```',
            '',
            '## Endpoints',
            '',
            'The plugin talks to the camera over three separate HTTPS endpoints. The talk and',
            'control endpoints are fixed in the camera firmware; the stream port can be edited',
            "in the camera's Settings tab if needed:",
            '',
            '```',
            renderKv([
                ['Stream', `https://${ipLine}:${streamPort}/https/stream/mixed`],
                ['Talk', `https://${ipLine}:${KASA_TALK_PORT}/https/speaker/audio/g711block`],
                ['Control', `https://${ipLine}:10443/data/LINKIE2.json`],
            ]),
            '```',
        ].join('\n');
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
        if (key === 'ip' || key === 'port' || key === 'username' || key === 'password') {
            // Tear down active streams + intercom — they're holding TCP sockets to the old
            // endpoint, which keeps delivering frames from the wrong camera until something
            // else closes them. Clients will reconnect against the new settings.
            for (const kill of [...this.activeStreamKills]) kill.resolve();
            this.stopIntercom().catch(() => {});
            // Re-probe child devices when network or auth settings change. Manually-added
            // cameras get their credentials filled in here (rather than at adoption), so this
            // is the moment the spotlight first becomes detectable.
            this.refreshChildDevices().catch(e => this.console.warn('refreshChildDevices failed', e));
        }
    }

    // OnOff drives the camera's status LED. HomeKit binds its CameraOperatingModeIndicator
    // characteristic to this when "Link Status Indicator" is enabled in the HomeKit per-camera
    // settings, so the user can toggle the LED from HomeKit. In Scrypted's UI this surfaces
    // as a plain on/off control on the camera page.
    async turnOn(): Promise<void> {
        await this.linkie().setLedStatus(true);
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.linkie().setLedStatus(false);
        this.on = false;
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [
            {
                container: 'rtsp',
                id: 'mixed',
                name: 'Mixed',
                video: {
                    codec: 'h264',
                },
                audio: {
                    codec: 'pcm_mulaw',
                },
                tool: 'scrypted',
                userConfigurable: false,
            },
        ];
    }

    async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const { ip, port, username, password } = this.storageSettings.values;

        if (!ip || !username || !password)
            throw new Error('Kasa camera is not configured. Set IP, username, and password.');

        const kasa = await KasaClient.connect({
            ip,
            port,
            username,
            password,
        });

        // Single shared kill switch: any teardown source (kasa close, ffmpeg exit, RTSP
        // client disconnect, pump error) resolves it, and every owned resource registers a
        // cleanup against it. spawnKasaStream owns the actual resource teardown; we just
        // surface the kill switch to settings-change handlers via activeStreamKills.
        const kill = new Deferred<void>();
        this.activeStreamKills.add(kill);
        kill.promise.finally(() => this.activeStreamKills.delete(kill));
        kasa.body.on('close', () => kill.resolve());
        kasa.body.on('error', () => kill.resolve());

        const ffmpegPath = await mediaManager.getFFmpegPath();
        // Read cached SPS/PPS from per-device storage. Lets spawnKasaStream skip the
        // ~1-2s preScanSpsPps wait on cold starts (HomeKit's perceived latency dominates
        // here). Cache survives plugin restarts. Stale-cache risk is bounded — in-band
        // SPS/PPS in the live bitstream supersede whatever we put in the SDP.
        const storage = deviceManager.getDeviceStorage(this.nativeId);
        const cachedSpsB64 = storage?.getItem('cachedSps') || undefined;
        const cachedPpsB64 = storage?.getItem('cachedPps') || undefined;
        const cachedSps = cachedSpsB64 ? Buffer.from(cachedSpsB64, 'base64') : undefined;
        const cachedPps = cachedPpsB64 ? Buffer.from(cachedPpsB64, 'base64') : undefined;

        let stream: KasaStreamHandle;
        try {
            stream = await spawnKasaStream({
                kasa,
                ffmpegPath,
                console: this.console,
                cachedSps,
                cachedPps,
                onFreshSpsPps: (sps, pps) => {
                    storage?.setItem('cachedSps', sps.toString('base64'));
                    storage?.setItem('cachedPps', pps.toString('base64'));
                },
            });
        } catch (e) {
            kasa.destroy();
            throw e;
        }
        kill.promise.finally(() => stream.kill());
        stream.exited.then(() => kill.resolve());

        const ffmpegInput: FFmpegInput = {
            url: stream.url,
            mediaStreamOptions: (await this.getVideoStreamOptions())[0],
            inputArguments: ['-rtsp_transport', 'tcp', '-i', stream.url],
        };

        return mediaManager.createFFmpegMediaObject(ffmpegInput);
    }

    async startIntercom(media: MediaObject): Promise<void> {
        // Some Scrypted clients call startIntercom again without an intervening stopIntercom
        // (e.g. switching audio sources). Tear down any prior session first so we don't leak
        // an in-flight ffmpeg process or a half-open POST to the camera.
        await this.stopIntercom();

        // `port` from storage is the receive-stream port (19443); the talk endpoint is on a
        // separate fixed port (KASA_TALK_PORT = 18443), so we don't read it here.
        const { ip, username, password } = this.storageSettings.values;
        if (!ip || !username || !password) throw new Error('Kasa camera is not configured.');

        const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(
            media,
            ScryptedMimeTypes.FFmpegInput,
        );

        const session = new KasaTalkSession({
            ip,
            port: KASA_TALK_PORT,
            username,
            password,
            console: this.console,
        });
        this.intercomSession = session;
        await session.start();

        // ffmpeg transcodes whatever audio Scrypted hands us (Opus/AAC/PCM/...) into raw
        // 8 kHz mono G.711 µ-law on stdout, which we chunk into 20 ms blocks and write
        // into the talk session as multipart parts.
        const ffmpegPath = await mediaManager.getFFmpegPath();
        // -loglevel error + -nostats: without these, ffmpeg emits a `size= time= bitrate=`
        // progress line every ~0.5 s during the talkback session. On long talks that's a
        // steady stream of stderr → string allocations + log I/O for no diagnostic value.
        // prettier-ignore
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostats',
            ...(ffmpegInput.inputArguments || []),
            '-vn', '-sn', '-dn',
            '-f', 'mulaw',
            '-ar', '8000',
            '-ac', '1',
            'pipe:1',
        ];
        const cp = child_process.spawn(ffmpegPath, args);
        this.intercomFfmpeg = cp;

        // Process-level cleanup: if our worker terminates while the intercom is active,
        // ffmpeg + the kasa POST socket would survive. Register a kill so worker exit
        // takes them down. Unregistered when the session closes normally.
        const unregisterCleanup = registerLiveCleanup(() => {
            try {
                cp.kill('SIGKILL');
            } catch {}
            session.close();
        });

        // Queue of incoming chunks plus byte total — avoids repeatedly Buffer.concat'ing the
        // accumulator on every stdout chunk (O(n²) over a long talk session). We only allocate
        // a fresh buffer when we have ≥ TALK_CHUNK_BYTES across the queue and need to emit.
        const queue: Buffer[] = [];
        let queuedBytes = 0;
        const takeChunk = (): Buffer => {
            if (queue.length === 1 && queue[0].length === TALK_CHUNK_BYTES) {
                queuedBytes -= TALK_CHUNK_BYTES;
                return queue.shift()!;
            }
            const out = Buffer.allocUnsafe(TALK_CHUNK_BYTES);
            let written = 0;
            while (written < TALK_CHUNK_BYTES) {
                const head = queue[0];
                const need = TALK_CHUNK_BYTES - written;
                if (head.length <= need) {
                    head.copy(out, written);
                    written += head.length;
                    queue.shift();
                } else {
                    head.copy(out, written, 0, need);
                    queue[0] = head.subarray(need);
                    written = TALK_CHUNK_BYTES;
                }
            }
            queuedBytes -= TALK_CHUNK_BYTES;
            return out;
        };
        cp.stdout!.on('data', (chunk: Buffer) => {
            queue.push(chunk);
            queuedBytes += chunk.length;
            while (queuedBytes >= TALK_CHUNK_BYTES) {
                const ok = session.writeAudio(takeChunk());
                // Backpressure: if the camera's HTTPS upload can't keep up, pause ffmpeg's
                // stdout until the body drains. Without this the PassThrough buffer would
                // grow without bound on a flaky network.
                if (!ok) {
                    cp.stdout!.pause();
                    session.onDrain(() => cp.stdout!.resume());
                    break;
                }
            }
        });
        cp.stderr!.on('data', d => this.console.log('intercom ffmpeg:', d.toString().trim()));
        cp.on('exit', () => {
            this.console.log('intercom ffmpeg exited');
            session.close();
        });

        // The camera can drop the talk uplink on its own (network blip, request error,
        // or the camera ending the response). Without observing that, ffmpeg would keep
        // running and consuming CPU long after the session is dead.
        session.onClose(() => {
            unregisterCleanup();
            if (this.intercomSession === session) {
                this.intercomSession = undefined;
                this.intercomFfmpeg = undefined;
                try {
                    cp.kill();
                } catch {}
            }
        });
    }

    async stopIntercom(): Promise<void> {
        const session = this.intercomSession;
        const cp = this.intercomFfmpeg;
        this.intercomSession = undefined;
        this.intercomFfmpeg = undefined;
        session?.close();
        try {
            cp?.kill();
        } catch {}
    }

    // Called by KasaPlugin.releaseDevice when this camera is removed (or the plugin is
    // uninstalled). Tears down everything that holds a kasa-side connection or a child
    // process — without this, Scrypted's worker-thread runtime can leave ffmpeg processes
    // and kasa HTTPS sockets running after the plugin is gone, since child_process is
    // owned by the host Node process, not the worker.
    release(): void {
        // Each kill triggers cleanupAll inside spawnKasaStream — kills ffmpeg, destroys
        // the kasa connection, closes UDP sockets and the local RTSP server.
        for (const kill of [...this.activeStreamKills]) kill.resolve();
        // Stop the intercom too if anything was active. stopIntercom is async only because
        // its signature is — the work it does is synchronous, so fire-and-forget is fine.
        this.stopIntercom().catch(() => {});
    }
}

interface KasaDiscoveryEntry {
    device: KasaDiscoveredDevice;
    // The cached entry expires so a stale IP/MAC mapping doesn't linger across DHCP changes.
    timeout: NodeJS.Timeout;
}

interface InventoryEntry {
    name: string;
    model: string;
    firmware: string;
    ip: string;
    mac: string;
}

const INVENTORY_GROUPS = ['Cameras', 'Bulbs / Dimmers', 'Plugs', 'Switches'] as const;
type InventoryGroup = (typeof INVENTORY_GROUPS)[number];

class KasaPlugin
    extends ScryptedDeviceBase
    implements DeviceProvider, DeviceCreator, DeviceDiscovery, Readme, Settings
{
    devices = new Map<string, KasaCamera | KasaPlug | KasaSwitch | KasaDimmer | KasaBulb>();
    discoveredDevices = new Map<string, KasaDiscoveryEntry>();
    // In-flight scan so concurrent scan=true calls share one network round-trip instead of
    // each kicking off its own broadcast + TCP sweep.
    private scanInFlight?: Promise<void>;
    // Suppress redundant re-scans for this long after one completes. Scrypted's discovery
    // UI fires scan=true on every type-filter click; a fresh scan + onDeviceEvent on every
    // click resets the user-applied filter. Returning cached results skips both.
    private static SCAN_COOLDOWN_MS = 5000;
    private lastScanAt = 0;

    constructor(nativeId?: string) {
        super(nativeId);
        this.systemDevice = {
            deviceCreator: 'Device',
            // Singular noun — Scrypted's UI auto-pluralizes the label, so 'Kasa Devices'
            // would render as "Kasa Devicess".
            deviceDiscovery: 'Kasa Device',
        };
        // Devices adopted before Readme was added need their interface lists topped up so
        // the Readme tab actually shows on the device page. Defer to next tick so the SDK
        // is fully wired before we walk the device manager.
        process.nextTick(() => this.migrateAddReadme().catch(e => this.console.warn('migrateAddReadme failed', e)));
    }

    // Plugin Settings tab — single button that re-runs UDP discovery and refreshes the
    // model / firmware / IP / MAC reported on every adopted device. Useful after a
    // firmware update, a device rename in the Kasa app, or a DHCP-rotated IP.
    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'refresh',
                title: 'Refresh devices',
                description:
                    'Re-run UDP discovery and update model, firmware, IP, and MAC for every adopted ' +
                    'Kasa device. Devices not currently reachable on the LAN are skipped.',
                type: 'button',
            },
        ];
    }

    async putSetting(key: string, _value: SettingValue): Promise<void> {
        if (key === 'refresh') await this.refreshAllDevices();
    }

    // Shared in-flight promise so two clicks of the Refresh button don't kick off two
    // overlapping discovery sweeps. Same pattern as scanInFlight in discoverDevices.
    private refreshInFlight?: Promise<void>;

    // Re-run UDP discovery and update each adopted device's `info` (model, firmware, IP,
    // MAC) from the fresh sysinfo response. Devices that don't respond to the sweep
    // (powered off, on a different subnet) are left alone — we don't want to clobber
    // good cached data with a one-shot network blip.
    private async refreshAllDevices(): Promise<void> {
        if (this.refreshInFlight) return this.refreshInFlight;
        this.refreshInFlight = this.refreshAllDevicesInternal().finally(() => {
            this.refreshInFlight = undefined;
        });
        return this.refreshInFlight;
    }

    private async refreshAllDevicesInternal(): Promise<void> {
        this.console.log('refresh: running UDP discovery sweep');
        const responses = await discoverKasa(2500, this.console).catch(e => {
            this.console.error('refresh: discovery failed', e);
            return [] as KasaDiscoveredDevice[];
        });

        // Auto-discovered devices use the Kasa deviceId as their nativeId, but
        // manually-created ones (createDevice) get a random nativeId — those would
        // never match here. Build a MAC index too so we can fall back to matching by
        // the MAC the device's `info` was stamped with.
        const normalizeMac = (mac: string | undefined): string => (mac ? mac.replace(/[:-]/g, '').toLowerCase() : '');
        const byDeviceId = new Map(responses.map(r => [r.deviceId, r]));
        const byMac = new Map<string, KasaDiscoveredDevice>();
        for (const r of responses) {
            const k = normalizeMac(r.mac);
            if (k) byMac.set(k, r);
        }

        // Prefer the freshly-observed string when it's non-empty, otherwise keep the
        // existing value. Discovery responses occasionally surface empty fields (and
        // sw_ver may be missing entirely), and we don't want a refresh to clobber
        // good cached data with an undefined.
        const preferStr = (fresh: string | undefined, existing: string | undefined): string | undefined =>
            fresh && fresh.trim() ? fresh : existing;

        let updated = 0;
        const missing: string[] = [];
        for (const nativeId of deviceManager.getNativeIds()) {
            if (!nativeId) continue;
            // Spotlight / siren children share the parent camera's sysinfo and are
            // already maintained by KasaCamera.refreshChildDevices.
            if (nativeId.endsWith('-spotlight') || nativeId.endsWith('-siren')) continue;
            const state = deviceManager.getDeviceState(nativeId);
            if (!state) continue;

            // Try deviceId match first (auto-discovered), then MAC match (covers
            // manually-created devices and any deviceId mismatches).
            let fresh = byDeviceId.get(nativeId);
            if (!fresh) {
                const macKey = normalizeMac(state.info?.mac);
                if (macKey) fresh = byMac.get(macKey);
            }
            if (!fresh) {
                missing.push(state.name || nativeId);
                continue;
            }

            const existing = state.info || {};
            const sw_ver = typeof fresh.sysinfo?.sw_ver === 'string' ? fresh.sysinfo.sw_ver : undefined;
            const newInfo = {
                ...existing,
                manufacturer: 'TP-Link Kasa',
                model: preferStr(fresh.model, existing.model),
                mac: preferStr(fresh.mac, existing.mac),
                // IP always takes the freshly-observed value — capturing a DHCP-rotated
                // address is the whole point of the refresh.
                ip: fresh.address,
                firmware: preferStr(sw_ver, existing.firmware),
            };

            // Re-publish without touching providedInterfaces — refreshing metadata, not
            // capabilities. Mixin-provided interfaces (HomeKit, etc.) live in `interfaces`
            // and would be incorrectly re-claimed if we passed those back.
            await deviceManager.onDeviceDiscovered({
                nativeId,
                name: state.name || nativeId,
                type: (state.type || ScryptedDeviceType.Unknown) as ScryptedDeviceType,
                interfaces: state.providedInterfaces || [],
                info: newInfo,
                room: state.room || undefined,
            });

            // Keep per-device storage in sync — that's what the device classes actually
            // use to connect. Update the in-memory storageSettings too if the device is
            // already instantiated, otherwise it would keep using the stale IP until
            // restarted.
            const storage = deviceManager.getDeviceStorage(nativeId);
            storage?.setItem('ip', fresh.address);
            const dev = this.devices.get(nativeId);
            if (dev?.storageSettings) dev.storageSettings.values.ip = fresh.address;

            updated++;
        }

        const summary = `refresh: ${updated} updated, ${missing.length} not found on LAN`;
        this.console.log(missing.length ? `${summary} (${missing.join(', ')})` : summary);
    }

    // One-time interface migration for devices adopted before this plugin exposed Readme.
    // Walks every nativeId and re-publishes the device with Readme appended to its
    // providedInterfaces. No-ops once every device already advertises Readme, so it's safe
    // to leave running on every plugin start.
    private async migrateAddReadme(): Promise<void> {
        for (const nativeId of deviceManager.getNativeIds()) {
            if (!nativeId) continue;
            // Spotlight / siren children only expose OnOff — no Readme to add. They're
            // re-published by KasaCamera.refreshChildDevices anyway.
            if (nativeId.endsWith('-spotlight') || nativeId.endsWith('-siren')) continue;
            const state = deviceManager.getDeviceState(nativeId);
            if (!state) continue;
            // providedInterfaces is the list this plugin originally registered; the
            // `interfaces` field also includes mixin-provided interfaces (HomeKit, etc.)
            // which we must NOT re-claim ownership of by passing them back to
            // onDeviceDiscovered.
            const provided = state.providedInterfaces || [];
            if (provided.includes(ScryptedInterface.Readme)) continue;
            await deviceManager.onDeviceDiscovered({
                nativeId,
                name: state.name || nativeId,
                type: (state.type || ScryptedDeviceType.Unknown) as ScryptedDeviceType,
                interfaces: [...provided, ScryptedInterface.Readme],
                info: state.info,
                room: state.room || undefined,
            });
        }
    }

    // Walks every adopted device and groups by Scrypted device type for the Readme
    // inventory. Child devices (spotlight / siren under each camera) are filtered out —
    // they share the parent camera's firmware so listing them separately is just noise.
    //
    // IP comes from per-device storage (the value the plugin actually uses to connect)
    // rather than `state.info.ip` (only set at adoption, doesn't reflect a manual edit
    // in per-device Settings or a DHCP-rotated update). Falls back to info.ip if the
    // storage value is missing — defends against legacy adoption paths that didn't
    // initialize the storage.
    private inventory(): Record<InventoryGroup, InventoryEntry[]> {
        const groups: Record<InventoryGroup, InventoryEntry[]> = {
            Cameras: [],
            'Bulbs / Dimmers': [],
            Plugs: [],
            Switches: [],
        };

        for (const nativeId of deviceManager.getNativeIds()) {
            if (!nativeId) continue;
            if (nativeId.endsWith('-spotlight') || nativeId.endsWith('-siren')) continue;

            const state = deviceManager.getDeviceState(nativeId);
            if (!state) continue;

            const type = state.type as ScryptedDeviceType | undefined;
            const info = (state.info || {}) as { model?: string; firmware?: string; ip?: string; mac?: string };
            const storedIp = deviceManager.getDeviceStorage(nativeId)?.getItem('ip');
            const entry: InventoryEntry = {
                name: state.name || '<unknown>',
                model: info.model || '?',
                firmware: info.firmware || '?',
                ip: storedIp || info.ip || '?',
                mac: info.mac || '?',
            };

            if (type === ScryptedDeviceType.Camera) groups['Cameras'].push(entry);
            else if (type === ScryptedDeviceType.Light) groups['Bulbs / Dimmers'].push(entry);
            else if (type === ScryptedDeviceType.Outlet) groups['Plugs'].push(entry);
            else if (type === ScryptedDeviceType.Switch) groups['Switches'].push(entry);
        }

        // Sort by name within each group for stable display order across renders.
        for (const entries of Object.values(groups)) entries.sort((a, b) => a.name.localeCompare(b.name));
        return groups;
    }

    // Plugin Readme tab — inventory data formatted as pre-aligned text inside fenced
    // code blocks. We avoid GFM-style pipe tables because Scrypted's markdown renderer
    // is plain CommonMark — it doesn't recognize them and collapses the pipe rows into
    // a single paragraph. A fenced code block renders as monospace preformatted text in
    // any CommonMark renderer and preserves alignment.
    async getReadmeMarkdown(): Promise<string> {
        const groups = this.inventory();
        const lines: string[] = ['# Kasa Plugin', '', 'Adopted devices, grouped by type.', ''];

        const headers = ['Name', 'Model', 'IP', 'MAC', 'Firmware'];
        let total = 0;
        for (const groupName of INVENTORY_GROUPS) {
            const entries = groups[groupName];
            if (!entries.length) continue;
            total += entries.length;

            const rows: string[][] = [
                headers,
                ...entries.map(e => [e.name, e.model, e.ip, formatKasaMac(e.mac), e.firmware]),
            ];
            // Compute per-column widths so columns line up cleanly inside the code block.
            const widths = headers.map((_, col) => Math.max(...rows.map(r => r[col].length)));

            lines.push(`## ${groupName} (${entries.length})`, '', '```');
            for (const row of rows) {
                // Two-space gutter between columns is enough to keep them visually distinct
                // without making the block too wide for narrow detail panels.
                lines.push(row.map((cell, col) => cell.padEnd(widths[col])).join('  '));
            }
            lines.push('```', '');
        }

        if (total === 0) lines.push('_No devices adopted yet._');
        return lines.join('\n');
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'kasaClass',
                title: 'Type',
                choices: ['Camera', 'Plug', 'Switch', 'Dimmer', 'Bulb'],
                value: 'Camera',
            },
            {
                key: 'name',
                title: 'Name',
                placeholder: 'Front Door, Living Room, etc.',
            },
            {
                key: 'room',
                title: 'Room',
                placeholder: 'Optional, e.g. Living Room',
                choices: getKnownRooms(),
                combobox: true,
            },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings, nativeId?: ScryptedNativeId): Promise<string> {
        nativeId ||= randomBytes(4).toString('hex');
        const room = settings.room?.toString() || undefined;
        const choice = settings.kasaClass?.toString() || 'Camera';
        // Map the user-friendly choice → internal kasaClass marker. Defaults to camera.
        const kasaClass: KasaDeviceClass =
            (
                {
                    Camera: 'camera',
                    Plug: 'plug',
                    Switch: 'switch',
                    Dimmer: 'dimmer',
                    Bulb: 'bulb',
                } as Record<string, KasaDeviceClass>
            )[choice] || 'camera';
        const name = settings.name?.toString() || (choice === 'Camera' ? 'Kasa Camera' : `Kasa ${choice}`);

        if (kasaClass === 'camera') {
            await this.registerCamera(nativeId, name, room);
            deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', 'camera');
            return nativeId;
        }
        await this.registerIotDevice(nativeId, name, room, kasaClass);
        return nativeId;
    }

    // Register a non-camera Kasa device (plug, switch, dimmer, bulb) with the appropriate
    // Scrypted device type + interfaces. IP/port are left empty; the user fills them in
    // through the per-device settings after creation.
    private async registerIotDevice(
        nativeId: string,
        name: string,
        room: string | undefined,
        kasaClass: KasaDeviceClass,
    ): Promise<void> {
        const interfaces = [ScryptedInterface.OnOff, ScryptedInterface.Settings, ScryptedInterface.Readme];
        let type: ScryptedDeviceType;
        switch (kasaClass) {
            case 'plug':
                type = ScryptedDeviceType.Outlet;
                break;
            case 'switch':
                type = ScryptedDeviceType.Switch;
                break;
            case 'dimmer':
                type = ScryptedDeviceType.Light;
                interfaces.push(ScryptedInterface.Brightness);
                break;
            case 'bulb':
                type = ScryptedDeviceType.Light;
                interfaces.push(ScryptedInterface.Brightness);
                // Color/color-temp interfaces are probed from sysinfo on adoption; manual-
                // create bulbs default to brightness only. The user can re-discover if they
                // need full color support detected automatically.
                break;
            default:
                throw new Error(`unknown kasaClass: ${kasaClass}`);
        }
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            type,
            interfaces,
            info: { manufacturer: 'TP-Link Kasa' },
            room: room || undefined,
        });
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', kasaClass);
    }

    private async registerCamera(
        nativeId: string,
        name: string,
        room?: string,
        info?: { model?: string; mac?: string; ip?: string; serialNumber?: string; firmware?: string },
    ): Promise<void> {
        const device: Device = {
            nativeId,
            name,
            type: ScryptedDeviceType.Camera,
            interfaces: [
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Settings,
                ScryptedInterface.Intercom,
                // Required so Scrypted routes child-device lookups (e.g. the spotlight)
                // through KasaCamera.getDevice rather than treating the camera as a leaf.
                ScryptedInterface.DeviceProvider,
                // OnOff drives the camera's status LED — HomeKit binds its
                // CameraOperatingModeIndicator characteristic to this.
                ScryptedInterface.OnOff,
                ScryptedInterface.Readme,
            ],
            info: {
                manufacturer: 'TP-Link Kasa',
                model: info?.model || undefined,
                mac: info?.mac || undefined,
                ip: info?.ip || undefined,
                serialNumber: info?.serialNumber || undefined,
                firmware: info?.firmware || undefined,
            },
            // Empty string would clear the room on re-discovery; pass undefined to leave alone.
            room: room || undefined,
        };
        await deviceManager.onDeviceDiscovered(device);
    }

    async discoverDevices(scan?: boolean): Promise<DiscoveredDevice[]> {
        // Discovery never runs unless explicitly requested (scan === true). When it does, an
        // in-flight scan is shared across overlapping callers so a single click never produces
        // more than one network round-trip; calls without scan=true just return the cache.
        if (scan) {
            if (this.scanInFlight) {
                await this.scanInFlight;
            } else if (Date.now() - this.lastScanAt < KasaPlugin.SCAN_COOLDOWN_MS) {
                // Recent scan already completed — return cached list without re-scanning
                // or re-firing onDeviceEvent (which would reset UI filters).
            } else {
                this.scanInFlight = this.runScan().finally(() => {
                    this.scanInFlight = undefined;
                    this.lastScanAt = Date.now();
                });
                await this.scanInFlight;
            }
        }

        const defaults = this.getDefaultCredentials();
        const rooms = getKnownRooms();
        const out: DiscoveredDevice[] = [];
        for (const { device } of this.discoveredDevices.values()) {
            const cls = classifyKasa(device);
            if (!cls) continue;
            out.push(this.buildDiscoveredDevice(device, cls, rooms, defaults));
        }
        return out;
    }

    private buildDiscoveredDevice(
        device: KasaDiscoveredDevice,
        cls: KasaDeviceClass,
        rooms: string[],
        defaults: { username: string; password: string },
    ): DiscoveredDevice {
        const info = {
            manufacturer: 'TP-Link Kasa',
            model: device.model,
            mac: device.mac,
            ip: device.address,
        };
        const fallbackName = device.alias || device.model || 'Kasa Device';

        // Common settings on every adoption form. Cameras add username/password below.
        const baseSettings: Setting[] = [
            { key: 'name', title: 'Name', value: fallbackName },
            { key: 'room', title: 'Room', placeholder: 'Optional, e.g. Living Room', choices: rooms, combobox: true },
        ];

        if (cls === 'camera') {
            return {
                nativeId: device.deviceId,
                name: fallbackName,
                description: `${device.model || 'Kasa Camera'} @ ${device.address}`,
                type: ScryptedDeviceType.Camera,
                interfaces: [
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Settings,
                    ScryptedInterface.Intercom,
                    ScryptedInterface.DeviceProvider,
                    ScryptedInterface.OnOff,
                    ScryptedInterface.Readme,
                ],
                info,
                // Cameras need the cloud account credentials too — auth on the stream/talk
                // endpoints. Plugs/bulbs are local-only with no auth.
                settings: [
                    ...baseSettings,
                    {
                        key: 'username',
                        title: 'Username (Kasa Email)',
                        placeholder: 'user@example.com',
                        value: defaults.username,
                    },
                    { key: 'password', title: 'Password (Kasa Account)', type: 'password', value: defaults.password },
                ],
            };
        }

        // Plug, Switch, Bulb — all share the same simpler adoption form.
        const interfaces = [ScryptedInterface.OnOff, ScryptedInterface.Settings, ScryptedInterface.Readme];
        let type: ScryptedDeviceType;
        if (cls === 'bulb') {
            type = ScryptedDeviceType.Light;
            interfaces.push(ScryptedInterface.Brightness);
            const caps = bulbCapabilities(device);
            if (caps.isColor) interfaces.push(ScryptedInterface.ColorSettingHsv);
            if (caps.isVariableColorTemp) interfaces.push(ScryptedInterface.ColorSettingTemperature);
        } else {
            // Dimmer plug/switch (HS220, KS230, ...) is almost always wired to a light, so
            // expose as Light. Plain plugs → Outlet; plain switches → Switch.
            const dimmer = isDimmer(device);
            if (dimmer) {
                type = ScryptedDeviceType.Light;
                interfaces.push(ScryptedInterface.Brightness);
            } else {
                type = cls === 'switch' ? ScryptedDeviceType.Switch : ScryptedDeviceType.Outlet;
            }
        }

        return {
            nativeId: device.deviceId,
            name: fallbackName,
            description: `${device.model || 'Kasa Device'} @ ${device.address}`,
            type,
            interfaces,
            info,
            settings: baseSettings,
        };
    }

    // Single-pass UDP discovery: broadcast + paced unicast sweep on the local /24, all on
    // one socket. Fast (~2.5 s) because there's no TCP handshake step and no second pass.
    private async runScan(): Promise<void> {
        try {
            const udpResults = await discoverKasa(2500, this.console).catch(e => {
                this.console.error('kasa udp discovery failed', e);
                return [] as KasaDiscoveredDevice[];
            });

            const skipped: string[] = [];
            const classCounts: Record<string, number> = {};
            let alreadyAdopted = 0;
            const existingNativeIds = new Set(deviceManager.getNativeIds());
            for (const d of udpResults) {
                if (existingNativeIds.has(d.deviceId)) {
                    alreadyAdopted++;
                    continue;
                }
                const cls = classifyKasa(d);
                if (!cls) {
                    skipped.push(`${d.alias || d.model || d.deviceId} (${d.type})`);
                    continue;
                }
                classCounts[cls] = (classCounts[cls] || 0) + 1;
                this.upsertDiscovered(d.deviceId, d);
            }

            const summaryParts = Object.entries(classCounts).map(([k, v]) => `${v} new ${k}(s)`);
            if (alreadyAdopted) summaryParts.push(`${alreadyAdopted} already adopted`);
            const summary = summaryParts.join(', ') || '0 supported devices';
            this.console.log(
                `kasa discovery: ${udpResults.length} responder(s), ${summary}` +
                    (skipped.length ? `, unsupported: ${skipped.join(', ')}` : ''),
            );
            void this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, undefined);
        } catch (e) {
            this.console.error('kasa discovery failed', e);
        }
    }

    // In typical home setups, every Kasa camera shares the same TP-Link account, so reuse
    // the credentials from any already-configured camera as defaults for newly discovered
    // ones. The user can still override per-camera in the adoption form.
    private getDefaultCredentials(): { username: string; password: string } {
        for (const nativeId of deviceManager.getNativeIds()) {
            if (!nativeId) continue;
            const storage = deviceManager.getDeviceStorage(nativeId);
            const username = storage?.getItem('username');
            const password = storage?.getItem('password');
            if (username && password) return { username, password };
        }
        return { username: '', password: '' };
    }

    private upsertDiscovered(deviceId: string, device: KasaDiscoveredDevice) {
        const existing = this.discoveredDevices.get(deviceId);
        if (existing) clearTimeout(existing.timeout);
        // Use unref() so the cache-expiry timer doesn't keep the plugin process awake; the
        // entries are best-effort and can be flushed whenever the process idles down.
        const timeout = setTimeout(() => this.discoveredDevices.delete(deviceId), 5 * 60 * 1000);
        timeout.unref?.();
        this.discoveredDevices.set(deviceId, { device, timeout });
    }

    async adoptDevice(adopt: AdoptDevice): Promise<string> {
        // ScryptedNativeId is `string | undefined`; the AdoptDevice flow always passes
        // a real id (it came from a DiscoveredDevice we ourselves emitted), but TS6
        // tightened the inference and won't narrow it for us.
        const nativeId = adopt.nativeId;
        if (!nativeId) throw new Error('adoptDevice called without a nativeId');

        const entry = this.discoveredDevices.get(nativeId);
        if (!entry) throw new Error('kasa device not found in discovered set; rescan and try again');

        const { device } = entry;
        const cls = classifyKasa(device);
        if (!cls) throw new Error(`kasa device type ${device.type} is not supported for adoption`);

        const name = adopt.settings.name?.toString() || device.alias || device.model || 'Kasa Device';
        const room = adopt.settings.room?.toString() || undefined;

        let id: string;
        if (cls === 'camera') id = await this.adoptCamera(adopt, nativeId, device, name, room);
        else id = await this.adoptIotDevice(adopt, nativeId, device, cls, name, room);

        clearTimeout(entry.timeout);
        this.discoveredDevices.delete(nativeId);
        void this.onDeviceEvent(ScryptedInterface.DeviceDiscovery, undefined);
        return id;
    }

    private async adoptCamera(
        adopt: AdoptDevice,
        nativeId: string,
        device: KasaDiscoveredDevice,
        name: string,
        room?: string,
    ): Promise<string> {
        // deviceId is the Kasa-issued 40-char hex per-unit identifier — treat it as the
        // serial number, which is what HomeKit and the UI expect under that label.
        await this.registerCamera(nativeId, name, room, {
            model: device.model,
            mac: device.mac,
            ip: device.address,
            serialNumber: device.deviceId,
            firmware: typeof device.sysinfo?.sw_ver === 'string' ? device.sysinfo.sw_ver : undefined,
        });
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', 'camera');
        const camera = (await this.getDevice(nativeId)) as KasaCamera;

        camera.storageSettings.values.ip = device.address;
        camera.storageSettings.values.port = KASA_DEFAULT_PORT;
        if (adopt.settings.username) camera.storageSettings.values.username = adopt.settings.username.toString();
        if (adopt.settings.password) camera.storageSettings.values.password = adopt.settings.password.toString();

        // Now that credentials are set, probe for child devices (spotlight, siren, etc.).
        camera.refreshChildDevices().catch(e => this.console.warn('post-adopt refreshChildDevices failed', e));

        return camera.id;
    }

    private async adoptIotDevice(
        adopt: AdoptDevice,
        nativeId: string,
        device: KasaDiscoveredDevice,
        cls: KasaDeviceClass,
        name: string,
        room?: string,
    ): Promise<string> {
        const interfaces: ScryptedInterface[] = [
            ScryptedInterface.OnOff,
            ScryptedInterface.Settings,
            ScryptedInterface.Readme,
        ];
        let type: ScryptedDeviceType;
        const caps = bulbCapabilities(device);
        // The marker we persist for getDevice routing. 'plug'/'switch' for plain on/off
        // devices, 'dimmer' for anything with brightness control, 'bulb' for true bulbs.
        let storedClass: KasaDeviceClass = cls;

        if (cls === 'bulb') {
            type = ScryptedDeviceType.Light;
            interfaces.push(ScryptedInterface.Brightness);
            if (caps.isColor) interfaces.push(ScryptedInterface.ColorSettingHsv);
            if (caps.isVariableColorTemp) interfaces.push(ScryptedInterface.ColorSettingTemperature);
        } else if (isDimmer(device)) {
            // Dimmer plug or dimmer switch — both expose as Light with Brightness.
            type = ScryptedDeviceType.Light;
            interfaces.push(ScryptedInterface.Brightness);
            storedClass = 'dimmer';
        } else {
            type = cls === 'switch' ? ScryptedDeviceType.Switch : ScryptedDeviceType.Outlet;
        }

        const sw_ver = typeof device.sysinfo?.sw_ver === 'string' ? device.sysinfo.sw_ver : undefined;
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            type,
            interfaces,
            room: room || undefined,
            info: {
                manufacturer: 'TP-Link Kasa',
                model: device.model,
                mac: device.mac,
                ip: device.address,
                serialNumber: device.deviceId,
                firmware: sw_ver,
            },
        });

        // Persist the class marker so getDevice routes to the right implementation —
        // multiple device classes share the same Scrypted device type (true bulbs and
        // dimmers both register as Light).
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', storedClass);

        const dev = await this.getDevice(nativeId);
        dev.storageSettings.values.ip = device.address;
        dev.storageSettings.values.port = KASA_IOT_PORT;
        if (cls === 'bulb' && dev instanceof KasaBulb) {
            dev.storageSettings.values.isColor = caps.isColor;
            dev.storageSettings.values.isVariableColorTemp = caps.isVariableColorTemp;
        }
        await dev.refreshState?.().catch(() => {});

        return dev.id;
    }

    // Routes a nativeId to the right device class. Adoption persists a `kasaClass` storage
    // marker (camera/plug/switch/bulb) which is the source of truth here — the Scrypted
    // device type alone is ambiguous (e.g. both true bulbs and dimmer plugs are `Light`).
    async getDevice(nativeId: ScryptedNativeId): Promise<any> {
        // The DeviceProvider contract types nativeId as nullable; the plugin device itself
        // (no nativeId) routes here too and we have nothing to instantiate for it.
        if (!nativeId) return undefined;
        let dev = this.devices.get(nativeId);
        if (!dev) {
            dev = this.instantiateDevice(nativeId);
            if (!dev) return undefined;
            this.devices.set(nativeId, dev);
        }
        return dev;
    }

    private instantiateDevice(
        nativeId: string,
    ): KasaCamera | KasaPlug | KasaSwitch | KasaDimmer | KasaBulb | undefined {
        const storage = deviceManager.getDeviceStorage(nativeId);
        const kasaClass = storage?.getItem('kasaClass');
        switch (kasaClass) {
            case 'camera':
                return new KasaCamera(nativeId);
            case 'bulb':
                return new KasaBulb(nativeId);
            case 'dimmer':
                return new KasaDimmer(nativeId);
            case 'switch':
                return new KasaSwitch(nativeId);
            case 'plug':
                return new KasaPlug(nativeId);
        }
        // Legacy fallback for devices adopted before kasaClass added 'dimmer'. Older
        // adoptions stored a `dimmer=true` flag on the device's KasaPlug/KasaSwitch
        // storage when the underlying device was a dimmer; promote those to KasaDimmer.
        if (storage?.getItem('dimmer') === 'true') return new KasaDimmer(nativeId);
        const state = deviceManager.getDeviceState(nativeId);
        switch (state?.type) {
            case ScryptedDeviceType.Camera:
                return new KasaCamera(nativeId);
            case ScryptedDeviceType.Switch:
                return new KasaSwitch(nativeId);
            case ScryptedDeviceType.Light:
                return new KasaDimmer(nativeId);
            case ScryptedDeviceType.Outlet:
                return new KasaPlug(nativeId);
        }
        return undefined;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        const dev = this.devices.get(nativeId);
        // Plug/Bulb instances run a state-poll timer that needs to be cleared.
        if (dev && 'release' in dev && typeof (dev as any).release === 'function') (dev as any).release();
        this.devices.delete(nativeId);
    }
}

export default KasaPlugin;
