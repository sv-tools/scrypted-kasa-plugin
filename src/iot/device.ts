import { OnOff, Readme, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { formatKasaMac, renderKv } from '../shared/readme';
import { EmeterReading, KASA_IOT_PORT, getEmeterRealtime, getSysInfo, kasaIotCall } from './protocol';

const STATE_POLL_INTERVAL_MS = 30000;

// Shared base for every Kasa "smarthome" single-relay device — outlets, switches, and
// dimmers. Only the on/off relay protocol lives here; dimmable devices add Brightness on
// top in KasaDimmer.
//
// Wire protocol (TCP/9999):
//   on/off:    {"system":{"set_relay_state":{"state":1|0}}}
//   query:     {"system":{"get_sysinfo":{}}}
//
// Multi-outlet strips (HS300, KP303) aren't modeled — they need per-child relay handling.
export abstract class KasaIotDevice extends ScryptedDeviceBase implements OnOff, Settings, Readme {
    storageSettings = new StorageSettings(this, {
        ip: {
            title: 'IP Address',
            placeholder: '192.168.1.100',
        },
        port: {
            title: 'Port',
            type: 'number',
            defaultValue: KASA_IOT_PORT,
        },
        // Energy-monitoring capability flag derived from sysinfo.feature (devices report
        // "TIM:ENE" when they have an emeter). Hidden because users don't toggle it —
        // it's set at adoption and re-evaluated on every sysinfo poll. Drives whether
        // the Readme tab fetches and displays the live wattage.
        hasEmeter: {
            type: 'boolean',
            hide: true,
        },
    });

    private pollTimer?: NodeJS.Timeout;
    private pollStartTimer?: NodeJS.Timeout;
    // Guard against overlapping polls: if a refresh is in-flight when the interval fires
    // (e.g., the camera is slow), the second call would open a parallel TCP connection
    // and could race the first response. Sharing the in-flight promise avoids that.
    private refreshInFlight?: Promise<void>;

    constructor(nativeId: string) {
        super(nativeId);
        // Drive an initial state refresh on next tick (so storageSettings is ready) and a
        // periodic poll thereafter so external state changes (other apps, physical button
        // presses) eventually surface in Scrypted/HomeKit. A small per-instance jitter on
        // the first poll spreads the load when many devices were started together.
        process.nextTick(() => this.refreshState().catch(e => this.console.warn('refresh state failed', e)));
        const jitter = Math.floor(Math.random() * STATE_POLL_INTERVAL_MS);
        this.pollStartTimer = setTimeout(() => {
            this.pollStartTimer = undefined;
            this.pollTimer = setInterval(() => this.refreshState().catch(() => {}), STATE_POLL_INTERVAL_MS);
        }, jitter);
    }

    async getSettings(): Promise<Setting[]> {
        const base = await this.storageSettings.getSettings();
        if (!this.storageSettings.values.hasEmeter) return base;

        // Devices with an emeter get a live readout block + a Refresh button so the user
        // can force a fresh sample without waiting for the 5 s cache to expire. Reads go
        // through the same cached emeterRealtime() the Readme uses, so opening the
        // Settings tab right after viewing the Readme is free.
        const reading = await this.emeterRealtime();
        const energy: Setting[] = [
            {
                key: 'energyPower',
                group: 'Energy',
                title: 'Power',
                readonly: true,
                value: reading ? `${reading.powerW.toFixed(1)} W` : '?',
            },
            {
                key: 'energyVoltage',
                group: 'Energy',
                title: 'Voltage',
                readonly: true,
                value: reading ? `${reading.voltageV.toFixed(1)} V` : '?',
            },
            {
                key: 'energyCurrent',
                group: 'Energy',
                title: 'Current',
                readonly: true,
                value: reading ? `${reading.currentA.toFixed(3)} A` : '?',
            },
            {
                key: 'energyTotal',
                group: 'Energy',
                title: 'Total energy',
                readonly: true,
                value: reading ? `${(reading.totalWh / 1000).toFixed(3)} kWh` : '?',
            },
            {
                key: 'refreshEnergy',
                group: 'Energy',
                title: 'Refresh',
                description: 'Discard the cached emeter sample and read fresh values from the device.',
                type: 'button',
            },
        ];
        return [...base, ...energy];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'refreshEnergy') {
            // Drop the cached value and fetch fresh; the new reading goes back into the
            // cache so subsequent renders see it. Emit a Settings event so the UI knows
            // to re-render with the updated readout fields.
            this.emeterCache = undefined;
            await this.emeterRealtime();
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        return this.storageSettings.putSetting(key, value);
    }

    // Per-device Readme tab. Surfaces static identity / network info — live state
    // (on/off, brightness) is not duplicated here, the device page already shows it.
    // Devices that report energy-monitoring capability also get a live Energy section
    // (lazy fetch — only fires when the user actually opens the Readme tab).
    async getReadmeMarkdown(): Promise<string> {
        const info = this.info || {};
        const ip = this.storageSettings.values.ip || info.ip || '?';
        const port = this.storageSettings.values.port || KASA_IOT_PORT;
        const lines: string[] = [
            `# ${this.name || 'Kasa Device'}`,
            '',
            '## Device',
            '',
            '```',
            renderKv([
                ['Model', info.model || '?'],
                ['Firmware', info.firmware || '?'],
                ['MAC', formatKasaMac(info.mac)],
                ['IP', ip],
                ['Port', String(port)],
            ]),
            '```',
            '',
        ];

        if (this.storageSettings.values.hasEmeter) {
            const reading = await this.emeterRealtime();
            const fmt = (n: number, digits: number) => n.toFixed(digits);
            const rows: [string, string][] = reading
                ? [
                      ['Power', `${fmt(reading.powerW, 1)} W`],
                      ['Voltage', `${fmt(reading.voltageV, 1)} V`],
                      ['Current', `${fmt(reading.currentA, 3)} A`],
                      ['Total', `${fmt(reading.totalWh / 1000, 3)} kWh`],
                  ]
                : [
                      ['Power', '?'],
                      ['Voltage', '?'],
                      ['Current', '?'],
                      ['Total', '?'],
                  ];
            lines.push('## Energy', '', '```', renderKv(rows), '```', '');
        }

        lines.push(
            '## Protocol',
            '',
            `Local TCP/${port} — Kasa's legacy "smarthome" wire format. No cloud account or`,
            'credentials required, the plugin reaches the device directly on the LAN.',
        );
        return lines.join('\n');
    }

    // Cache the most recent emeter reading for a short window so quick re-renders of
    // the Readme tab (focus events etc.) don't fan out into multiple TCP queries to the
    // plug. Errors cache as `undefined` so an offline plug doesn't keep retrying on
    // every render either — the next miss after the window will try again.
    private static EMETER_CACHE_MS = 5000;
    private emeterCache?: { value: EmeterReading | undefined; at: number };
    private emeterInFlight?: Promise<EmeterReading | undefined>;

    async emeterRealtime(): Promise<EmeterReading | undefined> {
        const now = Date.now();
        if (this.emeterCache && now - this.emeterCache.at < KasaIotDevice.EMETER_CACHE_MS) {
            return this.emeterCache.value;
        }
        if (this.emeterInFlight) return this.emeterInFlight;
        this.emeterInFlight = getEmeterRealtime(this.iotOptions())
            .catch(() => undefined)
            .finally(() => {
                this.emeterInFlight = undefined;
            });
        const value = await this.emeterInFlight;
        this.emeterCache = { value, at: Date.now() };
        return value;
    }

    async turnOn(): Promise<void> {
        await this.callIot({ system: { set_relay_state: { state: 1 } } });
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.callIot({ system: { set_relay_state: { state: 0 } } });
        this.on = false;
    }

    async refreshState(): Promise<void> {
        if (this.refreshInFlight) return this.refreshInFlight;
        this.refreshInFlight = this.refreshStateInternal().finally(() => {
            this.refreshInFlight = undefined;
        });
        return this.refreshInFlight;
    }

    private async refreshStateInternal(): Promise<void> {
        if (!this.storageSettings.values.ip) return;
        const sys = await getSysInfo(this.iotOptions());
        if (!sys) return;
        if (typeof sys.relay_state === 'number') this.on = sys.relay_state === 1;
        // Energy-monitoring capability is advertised in sysinfo.feature as "ENE"
        // (e.g. "TIM:ENE"). Cache the boolean so the Readme tab knows whether to
        // bother fetching live wattage.
        const hasEmeter = /ENE/i.test(typeof sys.feature === 'string' ? sys.feature : '');
        if (this.storageSettings.values.hasEmeter !== hasEmeter) {
            this.storageSettings.values.hasEmeter = hasEmeter;
        }
        // Subclasses with extra state extend via onSysInfo hook.
        this.onSysInfo(sys);
    }

    // Hook for subclasses to consume additional sysinfo fields (e.g. brightness for dimmers).
    protected onSysInfo(_sys: Record<string, any>): void {}

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
