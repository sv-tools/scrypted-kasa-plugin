import sdk, {
    AdoptDevice,
    Camera,
    Device,
    DeviceCreator,
    DeviceCreatorSettings,
    DeviceDiscovery,
    DeviceProvider,
    DiscoveredDevice,
    FFmpegInput,
    Intercom,
    MediaObject,
    MotionSensor,
    OnOff,
    PanTiltZoom,
    PanTiltZoomCommand,
    PanTiltZoomMovement,
    Readme,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
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
import { fetchKasaSnapshot, KASA_DEFAULT_PORT, KasaClient, KasaSnapshotError } from './camera/api';
import { KASA_TALK_PORT, KasaTalkSession } from './camera/intercom';
import { KASA_LINKIE_CAMERA_OFF, KasaLinkieClient, KasaLinkieError, KasaPtzDirection } from './camera/linkie';
import { KasaStreamHandle, registerLiveCleanup, spawnKasaStream } from './camera/stream';
import { KasaBulb } from './iot/bulb';
import { KasaDimmer } from './iot/dimmer';
import { KasaPlug } from './iot/plug';
import { KASA_IOT_PORT } from './iot/protocol';
import { KasaSwitch } from './iot/switch';
import { discoverKasa, KasaDiscoveredDevice } from './shared/discovery';
import { formatKasaMac, renderKv } from './shared/readme';
import { singleFlight } from './shared/single-flight';

// Stream-server-down handling (see KasaCamera.explainStreamServerDown).
// Ceiling for any hold inside getVideoStream. The objectdetector plugin ends a Video Analysis
// session (and logs "VideoAnalysis is hung") once its getVideoStream has been waiting over 30 s,
// and that clock includes the rebroadcast plugin's own 5 s restart delay plus our connect and
// switch check (~1 s), so stay well under 30 - 5 - 1.
const MAX_STREAM_HOLD_MS = 18_000;
// How long each failed stream attempt is held before it's reported, to slow the rebroadcast
// plugin's ~5 s retry loop while the stream server is known to be dead.
const STREAM_DOWN_RETRY_DELAY_MS = MAX_STREAM_HOLD_MS;
// How long the stream must stay down before an auto-reboot, and the minimum gap between two.
const STREAM_DOWN_REBOOT_AFTER_MS = 3 * 60_000;
const AUTO_REBOOT_COOLDOWN_MS = 30 * 60_000;

// While the camera is turned off (Privacy Mode), how long a stream attempt is held before it
// fails, and how often the switch is polled meanwhile. Turning Privacy Mode off through the
// switch device wakes the hold immediately.
const CAMERA_OFF_HOLD_MS = MAX_STREAM_HOLD_MS;
const CAMERA_OFF_POLL_MS = 5_000;
// While the camera is off, how often to check whether it was turned back on elsewhere (Kasa
// app). Stream attempts also notice, but HomeKit stops requesting streams from a camera it
// shows as off, so without this it could stay off in the Home app indefinitely.
const PRIVACY_POLL_MS = 60_000;

// Camera motion events (the "Motion events from camera" setting). The camera has no push, so
// its motion state is polled; one call takes ~30 ms on the kept-alive connection.
const MOTION_POLL_MS = 1_000;
// is_moving drops ~2 s after the camera's last alarm, so a person standing still flickers it.
// Hold motionDetected on this long after the last true, so HomeKit sees one event per visit.
const MOTION_HOLD_MS = 10_000;
// Failed polls back off from MOTION_POLL_MS up to this, so an unreachable camera isn't hammered.
const MOTION_POLL_MAX_BACKOFF_MS = 30_000;
// While the camera is off (Privacy Mode) it detects nothing; check back at this pace.
const MOTION_POLL_PRIVACY_MS = 5_000;

// The error for a camera turned off in Privacy Mode; getVideoStream holds on it.
class CameraOffError extends Error {
    constructor() {
        super('Kasa camera is turned off (privacy mode)');
        // Drop the stack: it's an expected state, not a fault, and it's logged on every retry.
        this.stack = this.message;
    }
}

// The stream error for a camera whose stream server has stopped while its control plane still
// answers (see KasaCamera.explainStreamServerDown).
class StreamServerDownError extends Error {
    constructor() {
        super('Kasa camera video stream is down (connection refused)');
        // Drop the stack: the state is logged once when it starts, and this on every retry.
        this.stack = this.message;
    }
}

const KASA_MANUFACTURER = 'TP-Link Kasa';

function formatDuration(ms: number): string {
    const min = Math.floor(ms / 60_000);
    if (min < 1) return 'less than a minute';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h ${min % 60} min`;
    return `${Math.floor(h / 24)} days`;
}

// PrivacyMode is newer than the @scrypted/sdk this plugin builds against, so it's declared here
// and its descriptor ships in package.json (scrypted.interfaceDescriptors) for the server.
// The HomeKit plugin binds it to the camera's own on/off in the Home app.
const PRIVACY_MODE_INTERFACE = 'PrivacyMode';
interface PrivacyMode {
    privacyMode?: boolean;
    setPrivacyMode(privacyMode: boolean): Promise<void>;
}

function isConnectionRefused(e: Error): boolean {
    return (e as NodeJS.ErrnoException).code === 'ECONNREFUSED' || /\bECONNREFUSED\b/.test(e.message);
}

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
    resolve!: (value: T) => void;
    promise: Promise<T>;

    constructor() {
        this.promise = new Promise<T>(resolve => {
            this.resolve = resolve;
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
        if (Array.isArray(d.sysinfo.children) && d.sysinfo.children.length) return undefined;
        const devName = d.sysinfo.dev_name || '';
        if (/switch|dimmer/i.test(devName)) return 'switch';
        return 'plug';
    }
    return undefined;
}

function isDimmer(d: KasaDiscoveredDevice): boolean {
    const sys = d.sysinfo;
    if (typeof sys.brightness === 'number') return true;
    if (/DIM/.test(sys.feature || '')) return true;
    // KS230 (3-way dimmer) doesn't report `brightness` in sysinfo at idle, and its
    // `feature` string doesn't include DIM either — but `dev_name` always says "Dimmer".
    return /dimmer/i.test(sys.dev_name || '');
}

interface BulbCapabilities {
    isColor: boolean;
    isVariableColorTemp: boolean;
}

function bulbCapabilities(d: KasaDiscoveredDevice): BulbCapabilities {
    return {
        isColor: d.sysinfo.is_color === 1,
        isVariableColorTemp: d.sysinfo.is_variable_color_temp === 1,
    };
}

// Interfaces every camera is published with. PanTiltZoom, PrivacyMode, Camera and MotionSensor
// are added later, per camera, when it has the feature or the user turns it on.
const CAMERA_INTERFACES = [
    ScryptedInterface.VideoCamera,
    ScryptedInterface.Settings,
    ScryptedInterface.Intercom,
    // Required so Scrypted routes child-device lookups (e.g. the spotlight) through
    // KasaCamera.getDevice rather than treating the camera as a leaf.
    ScryptedInterface.DeviceProvider,
    // OnOff drives the camera's status LED — HomeKit binds its CameraOperatingModeIndicator
    // characteristic to this.
    ScryptedInterface.OnOff,
    ScryptedInterface.Readme,
];

// How a plug, switch, dimmer or bulb is published, and the kasaClass marker stored for it.
// One place decides this for the discovery list, adoption and the manual "Add device" dialog,
// so what the list shows is what adoption creates. `device` is the discovery reply, when there
// is one; a manually added device gets only what its chosen class implies.
function iotDeviceShape(
    cls: Exclude<KasaDeviceClass, 'camera'>,
    device?: KasaDiscoveredDevice,
): { kasaClass: KasaDeviceClass; type: ScryptedDeviceType; interfaces: ScryptedInterface[] } {
    const interfaces = [ScryptedInterface.OnOff, ScryptedInterface.Settings, ScryptedInterface.Readme];
    if (cls === 'bulb') {
        interfaces.push(ScryptedInterface.Brightness);
        // Color support comes from sysinfo, so a manually added bulb starts with brightness
        // only; re-discovering it detects the rest.
        const caps = device && bulbCapabilities(device);
        if (caps?.isColor) interfaces.push(ScryptedInterface.ColorSettingHsv);
        if (caps?.isVariableColorTemp) interfaces.push(ScryptedInterface.ColorSettingTemperature);
        return { kasaClass: 'bulb', type: ScryptedDeviceType.Light, interfaces };
    }
    // A dimmer plug or switch (HS220, KS230, ...) is almost always wired to a light, so it is
    // exposed as a Light, like a bulb; the stored class is what tells the two apart.
    if (cls === 'dimmer' || (device && isDimmer(device))) {
        interfaces.push(ScryptedInterface.Brightness);
        return { kasaClass: 'dimmer', type: ScryptedDeviceType.Light, interfaces };
    }
    return {
        kasaClass: cls,
        type: cls === 'switch' ? ScryptedDeviceType.Switch : ScryptedDeviceType.Outlet,
        interfaces,
    };
}

const { deviceManager, mediaManager, systemManager } = sdk;

// Re-publishes an existing device with a changed interface list and/or info, keeping the rest.
// The list a caller builds must start from state.providedInterfaces, which is what this
// plugin registered; state.interfaces also holds mixin-provided ones (HomeKit, NVR, ...), and
// passing those back would claim them as ours.
async function republishDevice(
    nativeId: ScryptedNativeId,
    changes: { interfaces?: string[]; info?: Device['info'] },
): Promise<void> {
    const state = nativeId && deviceManager.getDeviceState(nativeId);
    if (!state) return;
    await deviceManager.onDeviceDiscovered({
        nativeId,
        name: state.name || nativeId,
        type: (state.type || ScryptedDeviceType.Unknown) as ScryptedDeviceType,
        interfaces: changes.interfaces ?? state.providedInterfaces ?? [],
        info: changes.info ?? state.info,
        // An empty string would clear the room; undefined leaves it alone.
        room: state.room || undefined,
    });
}

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

// The on/off child devices a camera can have. Each is published only when the camera answers
// the matching LINKIE2 probe, under the camera's nativeId plus the suffix.
interface CameraChildSpec {
    suffix: string;
    // Appended to the camera's name.
    label: string;
    type: ScryptedDeviceType;
    set(camera: KasaCamera, on: boolean): Promise<void>;
    // True when `set` writes the child's `on` itself, so the child must not.
    setsOwnState?: boolean;
}

const CAMERA_CHILDREN = {
    // The Kasa app calls this the "spotlight" (e.g. KC420WS). At the protocol level it is
    // dayNight.set_force_lamp_state: the firmware treats it as a generic forced-lamp state.
    spotlight: {
        suffix: '-spotlight',
        label: 'Spotlight',
        type: ScryptedDeviceType.Light,
        set: (camera, on) => camera.linkie().setForceLampState(on),
    },
    // The camera auto-stops the siren after the duration set in the Kasa app (default 30 s),
    // so the `on` shown in Scrypted may not reflect that auto-off until something polls again.
    siren: {
        suffix: '-siren',
        label: 'Siren',
        // HomeKit folds a camera's Light and Siren children into the camera accessory; any
        // other type is bridged as a standalone accessory.
        type: ScryptedDeviceType.Siren,
        set: (camera, on) => camera.linkie().setSirenState(on),
    },
    // The camera's own on/off, inverted so it reads naturally in HomeKit automations ("when I
    // arrive, turn on Kitchen Privacy Mode"): on = camera turned off. It mirrors the camera's
    // PrivacyMode, which does the work and keeps this child's state in step.
    privacy: {
        suffix: '-privacy',
        label: 'Privacy Mode',
        type: ScryptedDeviceType.Switch,
        set: (camera, on) => camera.setPrivacyMode(on),
        setsOwnState: true,
    },
} satisfies Record<string, CameraChildSpec>;
type CameraChildKind = keyof typeof CAMERA_CHILDREN;
const CAMERA_CHILD_KINDS = Object.keys(CAMERA_CHILDREN) as CameraChildKind[];

class KasaCameraChild extends ScryptedDeviceBase implements OnOff {
    constructor(
        private camera: KasaCamera,
        private spec: CameraChildSpec,
        nativeId: string,
    ) {
        super(nativeId);
    }

    turnOn(): Promise<void> {
        return this.set(true);
    }

    turnOff(): Promise<void> {
        return this.set(false);
    }

    private async set(on: boolean): Promise<void> {
        await this.spec.set(this.camera, on);
        if (!this.spec.setsOwnState) this.on = on;
    }
}

// Camera child devices share the parent's sysinfo. Anything that walks getNativeIds()
// (refresh, migrations, inventory) must skip them or they get re-published / double-counted.
function isCameraChildNativeId(nativeId: string): boolean {
    return CAMERA_CHILD_KINDS.some(kind => nativeId.endsWith(CAMERA_CHILDREN[kind].suffix));
}

// Scrypted PTZ magnitudes are -1..1; Kasa's set_move takes a 1..10 step size. Same
// ceil(|v| * 10) mapping the Reolink plugin uses, so UI arrow taps behave alike across brands.
function kasaPtzSpeed(v: number): number {
    return Math.min(10, Math.max(1, Math.ceil(Math.abs(v) * 10)));
}

class KasaCamera
    extends ScryptedDeviceBase
    implements
        VideoCamera,
        Camera,
        MotionSensor,
        Settings,
        Intercom,
        DeviceProvider,
        OnOff,
        PanTiltZoom,
        PrivacyMode,
        Readme
{
    private intercomSession?: KasaTalkSession;
    private intercomFfmpeg?: ChildProcess;
    // Child device objects, created on first use (see child()).
    private children = new Map<CameraChildKind, KasaCameraChild>();
    // Set while stream attempts are failing because the camera is turned off, so the
    // "turned off" / "back on" transitions are logged once instead of on every retry.
    private cameraOffLogged = false;
    // Bumped on every privacy change we make, so a camera-state probe that raced one can tell
    // its answer is stale.
    private privacyChanges = 0;
    private lastPrivacySet = false;
    private privacyPoll?: NodeJS.Timeout;
    // Set by release(); a refresh or stream retry still in flight must not re-arm the poll.
    private released = false;
    // Stream attempts parked in waitForCameraOn(), woken early when Privacy Mode is turned off.
    private cameraOffWaiters = new Set<() => void>();
    // Set while :19443 refuses connections but the control plane still answers: the camera's
    // stream server has died. Holds the time we first saw it, for the one-shot log line, the
    // recovery message, and the auto-reboot grace period.
    private streamDownSince?: number;
    private lastAutoRebootAt = 0;
    private streamStatus?: { state: 'active' | 'down' | 'off'; since: number; detail?: string };
    // Kill switches for any in-flight video streams. Stored so we can tear them down when
    // the user changes network/auth settings — otherwise the existing TCP connection keeps
    // talking to the old IP and clients see "phantom" video from a stale endpoint.
    private activeStreamKills = new Set<Deferred<void>>();
    // Camera motion polling: the pending poll timer, the timer that clears motionDetected after
    // the hold, and the current backoff after failed polls.
    private motionPoll?: NodeJS.Timeout;
    private motionPolling = false;
    private motionHoldTimer?: NodeJS.Timeout;
    private motionPollBackoffMs = MOTION_POLL_MS;
    private motionPollFailing = false;

    constructor(nativeId: string) {
        super(nativeId);
        // Probe-and-register child devices once settings are available. process.nextTick
        // defers past constructor so storageSettings is fully wired.
        process.nextTick(() => {
            // Resume watching for the camera coming back on even if the probe below can't reach
            // it; otherwise a persisted "off" would stay off in HomeKit indefinitely.
            if (this.privacyMode) this.setPrivacyPoll(true);
            // Motion can start now if MotionSensor is already published, as it is after a restart;
            // otherwise applyCameraFeatures below publishes it first.
            const provided = deviceManager.getDeviceState(this.nativeId)?.providedInterfaces;
            if (this.storageSettings.values.cameraMotion && provided?.includes(ScryptedInterface.MotionSensor))
                this.startMotionPoll();
            // After the refresh, which re-publishes providedInterfaces from its own snapshot and
            // would undo an interface change made while it ran.
            this.refreshChildDevices()
                .catch(e => this.console.warn('refreshChildDevices failed', e))
                .finally(() => this.applyCameraFeatures());
        });
    }

    private cachedLinkie?: { client: KasaLinkieClient; ip: string; username: string; password: string };
    linkie(): KasaLinkieClient {
        const { ip, username, password } = this.storageSettings.values;
        // Don't pass storageSettings.port — that's the stream port (19443). LINKIE2 lives
        // on its own fixed port (10443) which the client supplies as a default.
        const c = this.cachedLinkie;
        if (c && c.ip === ip && c.username === username && c.password === password) return c.client;
        // The old client's kept-alive socket points at the old endpoint or credentials.
        c?.client.destroy();
        const client = new KasaLinkieClient({ ip, username, password }, this.console);
        this.cachedLinkie = { client, ip, username, password };
        return client;
    }

    private childNativeId(kind: CameraChildKind): string {
        return `${this.nativeId}${CAMERA_CHILDREN[kind].suffix}`;
    }

    private child(kind: CameraChildKind): KasaCameraChild {
        let child = this.children.get(kind);
        if (!child) {
            child = new KasaCameraChild(this, CAMERA_CHILDREN[kind], this.childNativeId(kind));
            this.children.set(kind, child);
        }
        return child;
    }

    // Publishes a child the camera turned out to have, and returns its device object.
    private async publishChild(kind: CameraChildKind): Promise<KasaCameraChild> {
        await deviceManager.onDeviceDiscovered({
            nativeId: this.childNativeId(kind),
            name: `${this.name || 'Kasa Camera'} ${CAMERA_CHILDREN[kind].label}`,
            type: CAMERA_CHILDREN[kind].type,
            interfaces: [ScryptedInterface.OnOff],
            providerNativeId: this.nativeId,
            // Inherit the camera's room so children show up next to it in the UI.
            // Empty string would clear an existing room assignment, so pass undefined.
            room: this.room || undefined,
        });
        return this.child(kind);
    }

    // Shown as the read-only "Video stream" setting. It can't be the Online interface: the
    // rebroadcast mixin claims Online above us, the server only keeps the topmost implementer's
    // value, and that mixin never sets it false for a single-stream camera, so a camera whose
    // stream server died still read as online. Only the stream attempt knows, so it records this.
    private setStreamStatus(state: 'active' | 'down' | 'off', detail?: string): void {
        const prev = this.streamStatus;
        if (prev?.state === state && prev.detail === detail) return;
        this.streamStatus = { state, detail, since: prev?.state === state ? prev.since : Date.now() };
        // Refreshes the settings page if it is open. (The Readme card can't be used for this:
        // the UI fetches it once per page and doesn't listen for events.)
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    // The value is a single-line text field that the UI clips, so it carries only the state and
    // duration; the reason goes in the description, which wraps.
    private describeStreamStatus(): { value: string; description: string } {
        const s = this.streamStatus;
        if (!s) return { value: 'Not connected yet', description: 'No stream attempt since the plugin started.' };
        // Relative time: the server's clock is often UTC in a container, so a wall time would mislead.
        const ago = formatDuration(Date.now() - s.since);
        if (s.state === 'active')
            return { value: `Active for ${ago}`, description: 'The latest connection to the video stream succeeded.' };
        if (s.state === 'off')
            return { value: `Off for ${ago}`, description: 'The camera is turned off (Privacy Mode).' };
        return {
            value: `Down for ${ago}`,
            description: s.detail || 'The latest connection to the video stream failed.',
        };
    }

    // The SDK only generates accessors for the properties it knows, so privacyMode goes through
    // the device state directly.
    get privacyMode(): boolean | undefined {
        this._lazyLoadDeviceState();
        return (this as any)._deviceState?.privacyMode;
    }

    set privacyMode(value: boolean | undefined) {
        this._lazyLoadDeviceState();
        (this as any)._deviceState.privacyMode = value;
    }

    // Records the camera's on/off on both the camera (PrivacyMode) and the Privacy Mode child,
    // only when it changed, so repeated stream retries don't fire events. `force` covers the
    // refresh that first publishes PrivacyMode: the plugin's copy of providedInterfaces may not
    // include it yet right after onDeviceDiscovered, so the published check would skip the write.
    private updatePrivacyState(off: boolean, force = false): void {
        // Cameras without the switch never get PrivacyMode, and the server rejects writes to an
        // interface the device doesn't implement ("PrivacyMode not implemented").
        const published = deviceManager
            .getDeviceState(this.nativeId)
            ?.providedInterfaces?.includes(PRIVACY_MODE_INTERFACE);
        if (force || (published && this.privacyMode !== off)) this.privacyMode = off;
        // The child object is created lazily; a stream error can arrive before the first refresh
        // reached the camera, and the child's persisted state should still follow.
        const privacy =
            this.children.get('privacy') ??
            (deviceManager.getNativeIds().includes(this.childNativeId('privacy')) ? this.child('privacy') : undefined);
        if (privacy && privacy.on !== off) privacy.on = off;
        this.setPrivacyPoll(off);
    }

    private setPrivacyPoll(off: boolean): void {
        if (off && !this.privacyPoll && !this.released) {
            this.privacyPoll = setInterval(
                () =>
                    this.pollCameraBackOn().catch(e => this.console.warn('privacy poll failed:', (e as Error).message)),
                PRIVACY_POLL_MS,
            );
        } else if (!off && this.privacyPoll) {
            clearInterval(this.privacyPoll);
            this.privacyPoll = undefined;
        }
    }

    private async pollCameraBackOn(): Promise<void> {
        const changes = this.privacyChanges;
        if ((await this.linkie().getCameraEnabled()) !== 'on' || changes !== this.privacyChanges) return;
        this.console.log('camera was turned back on');
        this.updatePrivacyState(false);
        this.wakeCameraOffWaiters();
    }

    async setPrivacyMode(privacyMode: boolean): Promise<void> {
        await this.linkie().setCameraEnabled(!privacyMode);
        this.privacyChanges++;
        this.lastPrivacySet = privacyMode;
        this.updatePrivacyState(privacyMode);
        // A stream attempt may be parked waiting for the camera to come back on; let it
        // connect now instead of at its next poll.
        if (!privacyMode) this.wakeCameraOffWaiters();
    }

    // The two opt-in camera features. Each is published as an interface only while its setting is
    // on: Camera makes the Snapshot plugin take pictures from the camera instead of decoding a
    // prebuffer frame, and MotionSensor is where Video Analysis and HomeKit read motion from.
    // Runs are queued: each reads the settings when it starts, so after a quick on/off the last
    // change wins instead of an earlier run finishing late with the old values.
    private cameraFeaturesQueue: Promise<void> = Promise.resolve();
    private applyCameraFeatures(): Promise<void> {
        const run = this.cameraFeaturesQueue.then(() => this.applyCameraFeaturesNow());
        this.cameraFeaturesQueue = run.catch(() => {});
        return run;
    }

    private async applyCameraFeaturesNow(): Promise<void> {
        const { cameraMotion, cameraSnapshots } = this.storageSettings.values;
        // Stop before unpublishing MotionSensor and start after publishing it: the server rejects
        // a motionDetected write for an interface the device doesn't implement.
        if (!cameraMotion) this.stopMotionPoll();

        const provided = deviceManager.getDeviceState(this.nativeId)?.providedInterfaces;
        if (!provided) return;
        const optional: string[] = [ScryptedInterface.Camera, ScryptedInterface.MotionSensor];
        const want = provided.filter(i => !optional.includes(i));
        if (cameraSnapshots) want.push(ScryptedInterface.Camera);
        if (cameraMotion) want.push(ScryptedInterface.MotionSensor);
        if (want.length !== provided.length || !want.every(i => provided.includes(i)))
            await republishDevice(this.nativeId, { interfaces: want });

        if (cameraMotion) this.startMotionPoll();
    }

    // Bumped on every start/stop, so a poll that was in flight across one doesn't act on a
    // stopped loop or start a second one.
    private motionPollGeneration = 0;

    private startMotionPoll(): void {
        if (this.motionPolling || this.released) return;
        this.motionPolling = true;
        this.motionPollGeneration++;
        this.motionPollBackoffMs = MOTION_POLL_MS;
        // A true left in the device state (from before a restart, or by a removed Video Analysis
        // mixin) would otherwise stick until the camera's next detection. Unconditional: a value
        // a mixin wrote isn't in this plugin's copy of the state, so a `!== false` check misses it.
        this.motionDetected = false;
        this.scheduleMotionPoll(0);
    }

    private stopMotionPoll(): void {
        if (!this.motionPolling) return;
        this.haltMotionPoll();
        this.clearMotion();
    }

    // Ends the loop without writing motionDetected.
    private haltMotionPoll(): void {
        this.motionPolling = false;
        this.motionPollGeneration++;
        clearTimeout(this.motionPoll);
        this.motionPoll = undefined;
    }

    private clearMotion(): void {
        clearTimeout(this.motionHoldTimer);
        this.motionHoldTimer = undefined;
        if (this.motionDetected) this.motionDetected = false;
    }

    private scheduleMotionPoll(delayMs: number): void {
        const generation = this.motionPollGeneration;
        this.motionPoll = setTimeout(() => {
            this.motionPoll = undefined;
            if (generation === this.motionPollGeneration) this.pollMotion(generation);
        }, delayMs);
    }

    private async pollMotion(generation: number): Promise<void> {
        const { ip, username, password } = this.storageSettings.values;
        // A camera that is off detects nothing, and a manually added one may lack credentials.
        if (this.privacyMode || !ip || !username || !password) {
            this.clearMotion();
            this.scheduleMotionPoll(MOTION_POLL_PRIVACY_MS);
            return;
        }
        let delay = MOTION_POLL_MS;
        try {
            const moving = await this.linkie().getMotionDetected();
            if (generation !== this.motionPollGeneration) return;
            if (this.motionPollFailing) {
                this.motionPollFailing = false;
                this.console.log('camera motion polling recovered');
            }
            this.motionPollBackoffMs = MOTION_POLL_MS;
            if (moving) this.onCameraMotion();
        } catch (e) {
            if (generation !== this.motionPollGeneration) return;
            if (e instanceof KasaLinkieError && e.errCode === KASA_LINKIE_CAMERA_OFF) {
                // Turned off outside the plugin; Privacy Mode catches up through its own poll.
                this.clearMotion();
                delay = MOTION_POLL_PRIVACY_MS;
            } else {
                // Logged once per outage: at one poll a second, every failure would flood the console.
                if (!this.motionPollFailing) {
                    this.motionPollFailing = true;
                    this.console.warn('camera motion poll failed, retrying with backoff:', (e as Error).message);
                }
                delay = this.motionPollBackoffMs;
                this.motionPollBackoffMs = Math.min(this.motionPollBackoffMs * 2, MOTION_POLL_MAX_BACKOFF_MS);
            }
        }
        this.scheduleMotionPoll(delay);
    }

    // The camera's start and end are logged: a Video Analysis mixin in Replace mode hides this
    // device's motionDetected behind its own, so the console is where the camera's shows.
    private onCameraMotion(): void {
        if (!this.motionDetected) {
            this.console.log('camera motion started');
            this.motionDetected = true;
        }
        clearTimeout(this.motionHoldTimer);
        this.motionHoldTimer = setTimeout(() => {
            this.motionHoldTimer = undefined;
            if (this.motionPolling && this.motionDetected) {
                this.console.log('camera motion ended');
                this.motionDetected = false;
            }
        }, MOTION_HOLD_MS);
    }

    // Camera interface, published only while "Snapshots from camera" is on.
    async takePicture(_options?: RequestPictureOptions): Promise<MediaObject> {
        // The camera answers 503 when it's off; skip the round trip.
        if (this.privacyMode) throw new CameraOffError();
        const { ip, port, username, password } = this.storageSettings.values;
        const jpeg = await fetchKasaSnapshot({ ip, port, username, password }).catch((e: Error) => {
            // Turned off outside the plugin (Kasa app) since Privacy Mode last synced.
            if (e instanceof KasaSnapshotError && e.statusCode === 503) return undefined;
            throw e;
        });
        if (!jpeg) throw new CameraOffError();
        return mediaManager.createMediaObject(jpeg, 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        // The camera serves one fixed 640x360 JPEG; it takes no size or channel options.
        return [{ id: 'snapshot', name: 'Camera Snapshot', picture: { width: 640, height: 360 } }];
    }

    // Shared between concurrent triggers (constructor, putSetting, post-adoption). The probes
    // are sequential per call; two runs in parallel would double the request load on the
    // camera, and racing onDeviceDiscovered() could re-register children twice.
    readonly refreshChildDevices = singleFlight(() => this.refreshChildDevicesInternal());

    private async refreshChildDevicesInternal(): Promise<void> {
        const { ip, username, password } = this.storageSettings.values;
        if (!ip || !username || !password) return;

        const linkie = this.linkie();
        // Probe each capability sequentially. The Kasa iOS app issues LINKIE2 calls
        // serially; firing them in parallel against the same camera occasionally drops
        // responses (likely camera-side request serialization).
        const privacyChanges = this.privacyChanges;
        const ledState = await linkie.getLedStatus();
        const lampState = await linkie.getForceLampState();
        const sirenState = await linkie.getSirenState();
        const cameraEnabled = await linkie.getCameraEnabled();
        const ptzCapability = await linkie.getPtzCapability();
        const ptzPresets = ptzCapability ? await linkie.getPtzPresets() : [];

        if (ledState !== undefined) this.on = ledState === 'on';

        // PanTiltZoom and PrivacyMode are added on the camera itself (not a child), so only
        // re-publish when one is missing. Never removed on a failed probe: an unreachable camera
        // looks the same as an unsupported one, and the hardware can't lose its motor or its
        // on/off switch.
        const provided = deviceManager.getDeviceState(this.nativeId)?.providedInterfaces || [];
        const missing: string[] = [];
        if (ptzCapability && !provided.includes(ScryptedInterface.PanTiltZoom)) {
            this.console.log(`pan/tilt detected (max_x=${ptzCapability.maxX}, max_y=${ptzCapability.maxY})`);
            missing.push(ScryptedInterface.PanTiltZoom);
        }
        const privacyModeAdded = cameraEnabled !== undefined && !provided.includes(PRIVACY_MODE_INTERFACE);
        if (privacyModeAdded) missing.push(PRIVACY_MODE_INTERFACE);
        if (missing.length) await republishDevice(this.nativeId, { interfaces: [...provided, ...missing] });

        if (ptzCapability) {
            this.ptzCapabilities = {
                pan: true,
                tilt: true,
                zoom: false,
                presets: Object.fromEntries(ptzPresets.map(p => [String(p.index), p.name])),
            };
        }

        if (lampState !== undefined) (await this.publishChild('spotlight')).on = lampState === 'on';
        if (sirenState !== undefined) (await this.publishChild('siren')).on = sirenState === 'on';

        if (cameraEnabled !== undefined) {
            // This also creates the child object: getNativeIds() may not list it yet (the server
            // pushes that separately), and updatePrivacyState only syncs a child it can find.
            await this.publishChild('privacy');
            // A privacy change made during the probes is newer than cameraEnabled.
            const off = privacyChanges === this.privacyChanges ? cameraEnabled === 'off' : this.lastPrivacySet;
            this.updatePrivacyState(off, privacyModeAdded);
        }
    }

    async getDevice(nativeId: string): Promise<any> {
        const kind = CAMERA_CHILD_KINDS.find(k => nativeId === this.childNativeId(k));
        return kind && this.child(kind);
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        // Drop the cached child so state updates stop writing to a removed device; a later
        // refresh re-creates it if the camera still has the feature.
        for (const kind of CAMERA_CHILD_KINDS) {
            if (nativeId === this.childNativeId(kind)) this.children.delete(kind);
        }
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
        autoReboot: {
            title: 'Auto-reboot when video stops',
            type: 'boolean',
            defaultValue: false,
            description:
                'Reboot the camera automatically when its video stream has refused connections for ' +
                `${STREAM_DOWN_REBOOT_AFTER_MS / 60_000} minutes while it still answers controls. ` +
                `At most once every ${AUTO_REBOOT_COOLDOWN_MS / 60_000} minutes.`,
        },
        cameraMotion: {
            title: 'Motion events from camera',
            type: 'boolean',
            defaultValue: false,
            description:
                "Use the camera's own motion detection as this device's motion sensor, read over the local " +
                'network once a second. No video is decoded on the server. Sensitivity and zones come from ' +
                'the Kasa app. Person detection and a doorbell ring also count as motion. If Video Analysis ' +
                'runs on this camera, its Built-In Motion Sensor option decides which one wins (Replace, the ' +
                "default, ignores the camera's).",
        },
        cameraSnapshots: {
            title: 'Snapshots from camera',
            type: 'boolean',
            defaultValue: false,
            description:
                'Take snapshots from the camera (a 640x360 JPEG in about half a second) instead of decoding ' +
                'a frame from the video stream. For full-resolution snapshots, leave this off or set the ' +
                'Snapshot plugin option Snapshots from Prebuffer to Enabled.',
        },
    });

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'streamStatus',
                title: 'Video stream',
                type: 'string',
                readonly: true,
                ...this.describeStreamStatus(),
            },
            ...(await this.storageSettings.getSettings()),
            {
                key: 'reboot',
                title: 'Reboot camera',
                description:
                    'Restart the camera. Fixes a camera whose video stream stopped (connection refused ' +
                    'on the stream port) while it still answers controls. It is offline for about 30 s.',
                type: 'button',
            },
        ];
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
                ['Hardware', info.version || '?'],
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
            'The plugin talks to the camera over HTTPS on three ports. The talk and control',
            'ports are fixed in the camera firmware; the stream port can be edited in the',
            "camera's Settings tab if needed:",
            '',
            '```',
            renderKv([
                ['Stream', `https://${ipLine}:${streamPort}/https/stream/mixed`],
                ['Snapshot', `https://${ipLine}:${streamPort}/https/stream/snapshot.jpg`],
                ['Talk', `https://${ipLine}:${KASA_TALK_PORT}/https/speaker/audio/g711block`],
                ['Control', `https://${ipLine}:10443/data/LINKIE2.json`],
            ]),
            '```',
        ].join('\n');
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'reboot') {
            this.console.log('rebooting camera');
            await this.linkie().reboot();
            // The camera is about to drop every socket anyway; closing ours now lets clients
            // start their reconnect loop immediately instead of waiting for a read timeout.
            this.closeStreams();
            return;
        }
        await this.storageSettings.putSetting(key, value);
        if (key === 'cameraMotion' || key === 'cameraSnapshots') {
            await this.applyCameraFeatures();
            return;
        }
        if (key === 'ip' || key === 'port' || key === 'username' || key === 'password') {
            // Tear down active streams + intercom — they're holding TCP sockets to the old
            // endpoint, which keeps delivering frames from the wrong camera until something
            // else closes them. Clients will reconnect against the new settings.
            this.closeStreams();
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

    // Kasa only exposes discrete direction steps and saved viewpoints — there's no absolute
    // positioning, home command, or zoom. set_move's smallest step is ~50 units, so Absolute
    // can't be emulated precisely either; reject those instead of approximating.
    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        const linkie = this.linkie();
        if (command.movement === PanTiltZoomMovement.Preset || command.preset !== undefined) {
            const index = Number(command.preset);
            if (!Number.isInteger(index)) throw new Error(`invalid Kasa PTZ preset: ${command.preset}`);
            await linkie.ptzRunToPreset(index);
            return;
        }
        if (command.movement === PanTiltZoomMovement.Absolute || command.movement === PanTiltZoomMovement.Home) {
            throw new Error(`Kasa cameras do not support ${command.movement} PTZ movement`);
        }

        // Relative (default) and Continuous both map to one step per axis. Sequential, like
        // the other LINKIE2 calls: parallel requests to one camera occasionally drop responses.
        if (command.pan) {
            const dir: KasaPtzDirection = command.pan > 0 ? 'right' : 'left';
            await linkie.ptzMove(dir, kasaPtzSpeed(command.pan));
        }
        if (command.tilt) {
            const dir: KasaPtzDirection = command.tilt > 0 ? 'top' : 'bottom';
            await linkie.ptzMove(dir, kasaPtzSpeed(command.tilt));
        }
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

    // A camera turned off (Kasa app or the Privacy Mode switch) answers the stream with HTTP
    // 503. The rebroadcast plugin retries every ~5 s and logs each failure with its stack, so
    // confirm the cause once and hand back a short, stack-less error instead.
    private async explainStreamError(e: Error): Promise<Error> {
        if (isConnectionRefused(e)) return this.explainStreamServerDown(e);
        if (!/HTTP 503\b/.test(e.message)) return e;
        const changes = this.privacyChanges;
        if ((await this.linkie().getCameraEnabled()) !== 'off') return e;
        // Turned back on while the probe was in flight; its 'off' is stale.
        if (changes !== this.privacyChanges && !this.lastPrivacySet) return e;
        if (!this.cameraOffLogged) {
            this.cameraOffLogged = true;
            this.console.log('camera is turned off (privacy mode); video is unavailable until it is turned back on');
        }
        this.updatePrivacyState(true);
        return new CameraOffError();
    }

    // :19443 refusing connections while :10443 still answers means the camera's stream server
    // died (see Reboot camera). The rebroadcast plugin retries every ~5 s and logs every failure
    // with a multi-line stack, so: log the state once, hand back a short stack-less error, hold
    // each failure for STREAM_DOWN_RETRY_DELAY_MS so the retries slow down, and optionally reboot
    // the camera once the outage has lasted long enough.
    private async explainStreamServerDown(e: Error): Promise<Error> {
        // No answer from the control plane either: the camera is off the network, not a dead
        // stream server. Leave that error alone.
        if ((await this.linkie().getCameraEnabled()) === undefined) return e;

        const { port, autoReboot } = this.storageSettings.values;
        const now = Date.now();
        if (this.streamDownSince === undefined) {
            this.streamDownSince = now;
            this.console.warn(
                `video stream server is down (connection refused on :${port || KASA_DEFAULT_PORT}) while the camera ` +
                    'still answers controls. ' +
                    (autoReboot
                        ? `It will be rebooted if this lasts ${STREAM_DOWN_REBOOT_AFTER_MS / 60_000} minutes.`
                        : 'Press Reboot camera in Settings, or turn on Auto-reboot when video stops.'),
            );
        }

        if (
            autoReboot &&
            now - this.streamDownSince >= STREAM_DOWN_REBOOT_AFTER_MS &&
            now - this.lastAutoRebootAt >= AUTO_REBOOT_COOLDOWN_MS
        ) {
            this.lastAutoRebootAt = now;
            this.console.warn(
                `video stream has been down for ${Math.round((now - this.streamDownSince) / 1000)} s; rebooting the camera`,
            );
            this.linkie()
                .reboot()
                .catch(err => this.console.warn('auto-reboot failed:', (err as Error).message));
        }

        await new Promise(r => setTimeout(r, STREAM_DOWN_RETRY_DELAY_MS));
        return new StreamServerDownError();
    }

    wakeCameraOffWaiters(): void {
        for (const wake of [...this.cameraOffWaiters]) wake();
    }

    // Holds a stream attempt while the camera is turned off, for up to CAMERA_OFF_HOLD_MS,
    // polling the switch. Returns true as soon as the camera is back on (so the caller can
    // connect right away), false if it's still off when the hold runs out. The hold is what
    // slows the rebroadcast plugin's ~5 s retry loop during a long Privacy Mode stretch.
    private async waitForCameraOn(deadline: number): Promise<boolean> {
        while (Date.now() < deadline) {
            await new Promise<void>(resolve => {
                const wake = () => {
                    clearTimeout(timer);
                    this.cameraOffWaiters.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, Math.min(CAMERA_OFF_POLL_MS, Math.max(0, deadline - Date.now())));
                this.cameraOffWaiters.add(wake);
            });
            // The switch check can take up to the LINKIE timeout; never let it run past the
            // deadline, or the hold creeps over the Video Analysis watchdog.
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const state = await Promise.race([
                this.linkie().getCameraEnabled(),
                new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), remaining)),
            ]);
            if (state === 'on') return true;
        }
        return false;
    }

    async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const { ip, port, username, password } = this.storageSettings.values;
        // Any hold below counts from here, so the connect and switch checks are inside the budget.
        const holdDeadline = Date.now() + CAMERA_OFF_HOLD_MS;
        const privacyChanges = this.privacyChanges;

        if (!ip || !username || !password)
            throw new Error('Kasa camera is not configured. Set IP, username, and password.');

        let kasa: KasaClient | undefined;
        // A camera turned off (Privacy Mode) parks the attempt in waitForCameraOn() rather than
        // failing at once; if it comes back on during the hold, connect again straight away.
        for (let attempt = 0; !kasa; attempt++) {
            try {
                kasa = await KasaClient.connect({
                    ip,
                    port,
                    username,
                    password,
                });
            } catch (e) {
                const err = await this.explainStreamError(e as Error);
                if (err instanceof CameraOffError) this.setStreamStatus('off');
                else if (err instanceof StreamServerDownError)
                    this.setStreamStatus(
                        'down',
                        'The camera refuses video connections but still answers controls; its stream server has stopped. Press Reboot camera below.',
                    );
                else this.setStreamStatus('down', err.message);
                if (!(err instanceof CameraOffError) || attempt >= 1 || !(await this.waitForCameraOn(holdDeadline)))
                    throw err;
            }
        }
        this.setStreamStatus('active');
        if (this.streamDownSince !== undefined) {
            this.console.log(`video stream is back after ${Math.round((Date.now() - this.streamDownSince) / 1000)} s`);
            this.streamDownSince = undefined;
        }
        if (this.cameraOffLogged) {
            this.cameraOffLogged = false;
            this.console.log('camera is back on, video resumed');
        }
        // A connected stream means the camera is on, even if it was turned back on in the Kasa
        // app before any stream attempt saw it off; unless privacy was turned on mid-connect.
        if (privacyChanges === this.privacyChanges) this.updatePrivacyState(false);

        // Single shared kill switch: any teardown source (kasa close, RTSP client
        // disconnect, pump error) resolves it, and every owned resource registers a
        // cleanup against it. spawnKasaStream owns the actual resource teardown; we just
        // surface the kill switch to settings-change handlers via activeStreamKills.
        const kill = new Deferred<void>();
        this.activeStreamKills.add(kill);
        kill.promise.finally(() => this.activeStreamKills.delete(kill));
        kasa.body.on('close', () => kill.resolve());
        kasa.body.on('error', () => kill.resolve());

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
        //
        // Low-latency knobs (without these, talkback lagged ~10 s — the symptom was hearing
        // your own voice through the camera speaker only after releasing Push-to-Talk):
        //   -fflags +nobuffer  : skip libavformat's input prebuffer (typically 1-2 s on SDP/SRTP).
        //   -fflags +flush_packets, -flush_packets 1
        //                      : flush the AVIO output buffer after every encoded packet
        //                        instead of when the 32 KB buffer fills (~4 s of 8 kHz mulaw).
        //                        The two forms cover both global flags and the output-muxer
        //                        explicit option; cheap belt-and-suspenders.
        //   -flags low_delay   : codec-level low-delay decode/encode flag.
        //   -probesize 32, -analyzeduration 0
        //                      : skip the auto-detect probe phase, which would otherwise
        //                        wait for ~5 s of audio to estimate stream parameters
        //                        before producing the first output sample.
        //   -rtsp_transport tcp, -reorder_queue_size 0   (RTSP-only, conditional)
        //                      : force TCP-interleaved RTP and zero the demuxer's
        //                        out-of-order reordering window. Only emitted when the
        //                        input URL is RTSP; for non-RTSP inputs ffmpeg would just
        //                        warn "Option not found" but the conditional keeps the arg
        //                        list honest about which demuxer each option targets.
        //   -max_delay 0       : zero libavformat's max-delay setting. General — applies
        //                        to several demuxers, including RTSP/RTP — so safe to pass
        //                        unconditionally.
        //   -af aresample=async=0:min_hard_comp=0
        //                      : disable async resampling. ffmpeg auto-inserts aresample
        //                        when input/output sample rates differ (Opus 24 kHz →
        //                        mulaw 8 kHz); async=0 keeps it operating on tiny frames
        //                        without the multi-second resync window async=1 introduces.
        const inputArgs = ffmpegInput.inputArguments || [];
        const isRtspInput = inputArgs.some(a => typeof a === 'string' && a.startsWith('rtsp://'));
        // prettier-ignore
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostats',
            '-fflags', '+nobuffer+flush_packets',
            '-flags', 'low_delay',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-max_delay', '0',
            ...(isRtspInput ? ['-rtsp_transport', 'tcp', '-reorder_queue_size', '0'] : []),
            '-thread_queue_size', '1',
            '-use_wallclock_as_timestamps', '1',
            ...inputArgs,
            '-vn', '-sn', '-dn',
            '-af', 'aresample=async=0:min_hard_comp=0',
            '-f', 'mulaw',
            '-ar', '8000',
            '-ac', '1',
            '-flush_packets', '1',
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
        this.closeStreams();
        this.released = true;
        if (this.privacyPoll) clearInterval(this.privacyPoll);
        this.privacyPoll = undefined;
        // Not stopMotionPoll(): the device is going away, so don't publish a final
        // motionDetected write.
        this.haltMotionPoll();
        clearTimeout(this.motionHoldTimer);
        this.cachedLinkie?.client.destroy();
        this.cachedLinkie = undefined;
    }

    // Closes every live stream and the intercom. Each kill triggers cleanupAll inside
    // spawnKasaStream, which destroys the kasa connection and closes the local RTSP server.
    private closeStreams(): void {
        for (const kill of [...this.activeStreamKills]) kill.resolve();
        // stopIntercom is async only because its signature is — the work it does is
        // synchronous, so fire-and-forget is fine.
        this.stopIntercom().catch(() => {});
    }
}

interface KasaDiscoveryEntry {
    device: KasaDiscoveredDevice;
    // The cached entry expires so a stale IP/MAC mapping doesn't linger across DHCP changes.
    timeout: NodeJS.Timeout;
}

// Kasa reports the hardware revision as sysinfo.hw_ver ("1.0", "2.0", ...). It is published
// as DeviceInformation.version, which HomeKit surfaces as Hardware Revision.
function sysinfoHwVer(device: KasaDiscoveredDevice): string | undefined {
    const v = device.sysinfo?.hw_ver;
    return typeof v === 'string' && v.trim() ? v : undefined;
}

interface InventoryEntry {
    name: string;
    model: string;
    hardware: string;
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
        process.nextTick(() =>
            this.backfillHardwareVersion().catch(e => this.console.warn('backfillHardwareVersion failed', e)),
        );
    }

    // Devices adopted before the hardware version was recorded only get it from a refresh.
    // Run that sweep once per install instead of on every start: devices that never answer
    // discovery (offline, other subnet) would otherwise trigger a sweep on each restart.
    private async backfillHardwareVersion(): Promise<void> {
        if (this.storage.getItem('hardwareVersionBackfilled')) return;
        const needs = deviceManager.getNativeIds().some(nativeId => {
            if (!nativeId || isCameraChildNativeId(nativeId)) return false;
            const state = deviceManager.getDeviceState(nativeId);
            return !!state && !state.info?.version;
        });
        if (needs) await this.refreshAllDevices();
        this.storage.setItem('hardwareVersionBackfilled', 'true');
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
                    'Re-run UDP discovery and update model, hardware version, firmware, IP, and MAC for every adopted ' +
                    'Kasa device. Devices not currently reachable on the LAN are skipped.',
                type: 'button',
            },
        ];
    }

    async putSetting(key: string, _value: SettingValue): Promise<void> {
        if (key === 'refresh') await this.refreshAllDevices();
    }

    // Re-run UDP discovery and update each adopted device's `info` (model, hardware version,
    // firmware, IP, MAC) from the fresh sysinfo response. Devices that don't respond to the sweep
    // (powered off, on a different subnet) are left alone — we don't want to clobber
    // good cached data with a one-shot network blip. Shared, so two clicks of the Refresh
    // button don't start two overlapping sweeps.
    private refreshAllDevices = singleFlight(() => this.refreshAllDevicesInternal());

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
            // Camera children (spotlight / siren / privacy) share the parent camera's sysinfo and are
            // already maintained by KasaCamera.refreshChildDevices.
            if (isCameraChildNativeId(nativeId)) continue;
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
            const newInfo = {
                ...existing,
                manufacturer: KASA_MANUFACTURER,
                model: preferStr(fresh.model, existing.model),
                mac: preferStr(fresh.mac, existing.mac),
                // IP always takes the freshly-observed value — capturing a DHCP-rotated
                // address is the whole point of the refresh.
                ip: fresh.address,
                firmware: preferStr(fresh.firmware, existing.firmware),
                version: preferStr(sysinfoHwVer(fresh), existing.version),
            };

            // Metadata only; the interface list stays as it is.
            await republishDevice(nativeId, { info: newInfo });

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
            // Camera children only expose OnOff — no Readme to add. They're
            // re-published by KasaCamera.refreshChildDevices anyway.
            if (isCameraChildNativeId(nativeId)) continue;
            const state = deviceManager.getDeviceState(nativeId);
            if (!state) continue;
            const provided = state.providedInterfaces || [];
            if (provided.includes(ScryptedInterface.Readme)) continue;
            await republishDevice(nativeId, { interfaces: [...provided, ScryptedInterface.Readme] });
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
            if (isCameraChildNativeId(nativeId)) continue;

            const state = deviceManager.getDeviceState(nativeId);
            if (!state) continue;

            const type = state.type as ScryptedDeviceType | undefined;
            const info = (state.info || {}) as {
                model?: string;
                version?: string;
                firmware?: string;
                ip?: string;
                mac?: string;
            };
            const storedIp = deviceManager.getDeviceStorage(nativeId)?.getItem('ip');
            const entry: InventoryEntry = {
                name: state.name || '<unknown>',
                model: info.model || '?',
                hardware: info.version || '?',
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

        const headers = ['Name', 'Model', 'HW', 'IP', 'MAC', 'Firmware'];
        let total = 0;
        for (const groupName of INVENTORY_GROUPS) {
            const entries = groups[groupName];
            if (!entries.length) continue;
            total += entries.length;

            const rows: string[][] = [
                headers,
                ...entries.map(e => [e.name, e.model, e.hardware, e.ip, formatKasaMac(e.mac), e.firmware]),
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
        kasaClass: Exclude<KasaDeviceClass, 'camera'>,
    ): Promise<void> {
        const shape = iotDeviceShape(kasaClass);
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            type: shape.type,
            interfaces: shape.interfaces,
            info: { manufacturer: KASA_MANUFACTURER },
            room: room || undefined,
        });
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', shape.kasaClass);
    }

    private async registerCamera(
        nativeId: string,
        name: string,
        room?: string,
        info?: {
            model?: string;
            mac?: string;
            ip?: string;
            serialNumber?: string;
            firmware?: string;
            version?: string;
        },
    ): Promise<void> {
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            type: ScryptedDeviceType.Camera,
            interfaces: [...CAMERA_INTERFACES],
            info: {
                manufacturer: KASA_MANUFACTURER,
                model: info?.model || undefined,
                mac: info?.mac || undefined,
                ip: info?.ip || undefined,
                serialNumber: info?.serialNumber || undefined,
                firmware: info?.firmware || undefined,
                version: info?.version || undefined,
            },
            // Empty string would clear the room on re-discovery; pass undefined to leave alone.
            room: room || undefined,
        });
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', 'camera');
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
            manufacturer: KASA_MANUFACTURER,
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
                interfaces: [...CAMERA_INTERFACES],
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

        // Plug, switch, dimmer, bulb — all share the same simpler adoption form.
        const { type, interfaces } = iotDeviceShape(cls, device);
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
            firmware: device.firmware,
            version: sysinfoHwVer(device),
        });
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
        cls: Exclude<KasaDeviceClass, 'camera'>,
        name: string,
        room?: string,
    ): Promise<string> {
        const shape = iotDeviceShape(cls, device);
        await deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            type: shape.type,
            interfaces: shape.interfaces,
            room: room || undefined,
            info: {
                manufacturer: KASA_MANUFACTURER,
                model: device.model,
                mac: device.mac,
                ip: device.address,
                serialNumber: device.deviceId,
                firmware: device.firmware,
                version: sysinfoHwVer(device),
            },
        });

        // Persist the class marker so getDevice routes to the right implementation —
        // multiple device classes share the same Scrypted device type (true bulbs and
        // dimmers both register as Light).
        deviceManager.getDeviceStorage(nativeId).setItem('kasaClass', shape.kasaClass);

        const dev = await this.getDevice(nativeId);
        dev.storageSettings.values.ip = device.address;
        dev.storageSettings.values.port = KASA_IOT_PORT;
        if (dev instanceof KasaBulb) {
            const caps = bulbCapabilities(device);
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
        // Every device class holds timers or connections that release() has to clear.
        this.devices.get(nativeId)?.release();
        this.devices.delete(nativeId);
    }
}

export default KasaPlugin;
