import { Readme, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';
import type { StorageSettings } from '@scrypted/sdk/storage-settings';
import { formatKasaMac, renderKv } from '../shared/readme';
import { KASA_IOT_PORT, kasaIotCall } from './protocol';

const STATE_POLL_INTERVAL_MS = 30000;

// The settings every IOT device has. Each class spreads these into its own StorageSettings
// next to its family-specific ones.
export const IOT_NETWORK_SETTINGS = {
    ip: {
        title: 'IP Address',
        placeholder: '192.168.1.100',
    },
    port: {
        title: 'Port',
        type: 'number',
        defaultValue: KASA_IOT_PORT,
    },
} as const;

// What every Kasa device on the local TCP/9999 protocol shares: where it lives on the network
// and a state poll, so external changes (Kasa app, physical button) eventually reach
// Scrypted/HomeKit. Relay devices (KasaIotDevice) and bulbs (KasaBulb) differ in the commands
// they send and in what they read out of sysinfo.
export abstract class KasaIotBase extends ScryptedDeviceBase implements Settings, Readme {
    abstract storageSettings: StorageSettings<'ip' | 'port'>;

    private pollTimer?: NodeJS.Timeout;
    private pollStartTimer?: NodeJS.Timeout;
    // Guard against overlapping polls: if a refresh is in-flight when the interval fires
    // (e.g., the device is slow), the second call would open a parallel TCP connection
    // and could race the first response. Sharing the in-flight promise avoids that.
    private refreshInFlight?: Promise<void>;

    constructor(nativeId: string) {
        super(nativeId);
        // Drive an initial state refresh on next tick (so storageSettings is ready) and a
        // periodic poll thereafter. A per-instance jitter on the first poll spreads the load
        // when many devices were started together.
        process.nextTick(() => this.refreshState().catch(e => this.console.warn('refresh state failed', e)));
        const jitter = Math.floor(Math.random() * STATE_POLL_INTERVAL_MS);
        this.pollStartTimer = setTimeout(() => {
            this.pollStartTimer = undefined;
            this.pollTimer = setInterval(() => this.refreshState().catch(() => {}), STATE_POLL_INTERVAL_MS);
        }, jitter);
    }

    getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.storageSettings.putSetting(key, value);
    }

    abstract getReadmeMarkdown(): Promise<string>;

    // The title and "Device" section every per-device Readme starts with: static identity and
    // network info. Live state isn't repeated there; the device page already shows it.
    protected readmeDeviceSection(fallbackName: string): string[] {
        const info = this.info || {};
        return [
            `# ${this.name || fallbackName}`,
            '',
            '## Device',
            '',
            '```',
            renderKv([
                ['Model', info.model || '?'],
                ['Hardware', info.version || '?'],
                ['Firmware', info.firmware || '?'],
                ['MAC', formatKasaMac(info.mac)],
                ['IP', this.storageSettings.values.ip || info.ip || '?'],
                ['Port', String(this.readmePort)],
            ]),
            '```',
            '',
        ];
    }

    protected get readmePort(): number {
        return this.storageSettings.values.port || KASA_IOT_PORT;
    }

    async refreshState(): Promise<void> {
        if (this.refreshInFlight) return this.refreshInFlight;
        this.refreshInFlight = this.readState().finally(() => {
            this.refreshInFlight = undefined;
        });
        return this.refreshInFlight;
    }

    private async readState(): Promise<void> {
        // A manually added device has no address until the user fills it in.
        if (!this.storageSettings.values.ip) return;
        await this.refreshStateInternal();
    }

    // Queries the device and copies its state onto this device's properties.
    protected abstract refreshStateInternal(): Promise<void>;

    // Assigning a device property is an RPC, and the server re-saves the device for each one
    // even when the value is the same. The poll reads the same values almost every time, so
    // only write the ones that changed.
    protected update<K extends 'on' | 'brightness' | 'colorTemperature'>(key: K, value: ScryptedDeviceBase[K]): void {
        if (this[key] !== value) (this as ScryptedDeviceBase)[key] = value;
    }

    protected callIot(command: Record<string, any>): Promise<any> {
        return kasaIotCall(this.iotOptions(), command);
    }

    protected iotOptions() {
        return {
            host: this.storageSettings.values.ip,
            port: this.storageSettings.values.port,
        };
    }

    release(): void {
        clearInterval(this.pollTimer);
        clearTimeout(this.pollStartTimer);
    }
}
