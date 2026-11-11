import { OnOff, ScryptedInterface, Setting, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { renderKv } from '../shared/readme';
import { singleFlight } from '../shared/single-flight';
import { IOT_NETWORK_SETTINGS, KasaIotBase } from './base';
import { EmeterReading, EnergyStat, getEmeterRealtime, getEnergyStats, getPlugDate, getSysInfo } from './protocol';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const HISTORY_MONTHS = 12;

// Usage history from the plug's own daily and monthly totals, newest first. Days and months
// the plug has no entry for count as 0, since it leaves out the ones without usage.
interface EnergyHistory {
    todayWh: number;
    monthWh: number;
    days: [string, number][];
    months: [string, number][];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const kwh = (wh: number) => `${(wh / 1000).toFixed(3)} kWh`;

// Shared base for every Kasa "smarthome" single-relay device — outlets, switches, and
// dimmers. Only the on/off relay protocol lives here; dimmable devices add Brightness on
// top in KasaDimmer.
//
// Wire protocol (TCP/9999):
//   on/off:    {"system":{"set_relay_state":{"state":1|0}}}
//   LED:       {"system":{"set_led_off":{"off":1|0}}}
//   query:     {"system":{"get_sysinfo":{}}}
//
// Multi-outlet strips (HS300, KP303) aren't modeled — they need per-child relay handling.
export abstract class KasaIotDevice extends KasaIotBase implements OnOff {
    storageSettings = new StorageSettings(this, {
        ...IOT_NETWORK_SETTINGS,
        // Energy-monitoring capability flag derived from sysinfo.feature (devices report
        // "TIM:ENE" when they have an emeter). Hidden because users don't toggle it —
        // it's set at adoption and re-evaluated on every sysinfo poll. Drives whether
        // the Readme tab fetches and displays the live wattage.
        hasEmeter: {
            type: 'boolean',
            hide: true,
        },
    });

    // The device's own status LED, from sysinfo.led_off. Undefined until a poll has seen the
    // field; devices without it don't get the setting.
    private ledOff?: boolean;

    async getSettings(): Promise<Setting[]> {
        const base = await this.storageSettings.getSettings();
        if (this.ledOff !== undefined) {
            base.push({
                key: 'statusLed',
                title: 'Status LED',
                description: "The device's own indicator light. Off keeps it dark regardless of the relay state.",
                type: 'boolean',
                value: !this.ledOff,
            });
        }
        if (!this.storageSettings.values.hasEmeter) return base;

        // Devices with an emeter get a live readout block + a Refresh button so the user
        // can force a fresh sample without waiting for the 5 s cache to expire. Reads go
        // through the same cached emeterRealtime() the Readme uses, so opening the
        // Settings tab right after viewing the Readme is free.
        // One after the other: parallel connections to one plug occasionally lose a reply.
        const reading = await this.emeterRealtime();
        const history = await this.energyHistory();
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
                key: 'energyToday',
                group: 'Energy',
                title: 'Today',
                readonly: true,
                value: history ? kwh(history.todayWh) : '?',
            },
            {
                key: 'energyMonth',
                group: 'Energy',
                title: 'This month',
                readonly: true,
                description: 'Daily and monthly history is on the Readme tab.',
                value: history ? kwh(history.monthWh) : '?',
            },
            {
                key: 'refreshEnergy',
                group: 'Energy',
                title: 'Refresh',
                description: 'Discard the cached energy readings and read fresh values from the device.',
                type: 'button',
            },
        ];
        return [...base, ...energy];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'statusLed') {
            const off = !(value === true || value === 'true');
            await this.callIot({ system: { set_led_off: { off: off ? 1 : 0 } } });
            this.ledOff = off;
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'refreshEnergy') {
            // Drop the cached value and fetch fresh; the new reading goes back into the
            // cache so subsequent renders see it. Emit a Settings event so the UI knows
            // to re-render with the updated readout fields.
            this.emeterCache = undefined;
            this.energyHistoryCache = undefined;
            await this.emeterRealtime();
            await this.energyHistory();
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
        const lines = this.readmeDeviceSection('Kasa Device');

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
            const history = await this.energyHistory();
            rows.push(
                ['Today', history ? kwh(history.todayWh) : '?'],
                ['This month', history ? kwh(history.monthWh) : '?'],
            );
            lines.push('## Energy', '', '```', renderKv(rows), '```', '');
            if (history) {
                const table = (entries: [string, number][]) => renderKv(entries.map(([k, wh]) => [k, kwh(wh)]));
                lines.push(
                    `## Daily usage (last ${HISTORY_DAYS} days)`,
                    '',
                    '```',
                    table(history.days),
                    '```',
                    '',
                    `## Monthly usage (last ${HISTORY_MONTHS} months)`,
                    '',
                    '```',
                    table(history.months),
                    '```',
                    '',
                );
            }
        }

        lines.push(
            '## Protocol',
            '',
            `Local TCP/${this.readmePort} — Kasa's legacy "smarthome" wire format. No cloud account or`,
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

    // Building it takes three requests and the totals move slowly, so it's cached longer than
    // the live reading.
    private static ENERGY_HISTORY_CACHE_MS = 60_000;
    private energyHistoryCache?: { value: EnergyHistory | undefined; at: number };
    private loadEnergyHistory = singleFlight(async () => {
        const value = await this.fetchEnergyHistory().catch(() => undefined);
        this.energyHistoryCache = { value, at: Date.now() };
        return value;
    });

    async energyHistory(): Promise<EnergyHistory | undefined> {
        const cached = this.energyHistoryCache;
        if (cached && Date.now() - cached.at < KasaIotDevice.ENERGY_HISTORY_CACHE_MS) return cached.value;
        return this.loadEnergyHistory();
    }

    private async fetchEnergyHistory(): Promise<EnergyHistory | undefined> {
        const options = this.iotOptions();
        const today = await getPlugDate(options);
        if (!today) return undefined;
        const prevMonth =
            today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
        // The last 30 days reach into the previous month, and the last 12 months into the
        // previous year; one request covers each pair.
        const current = await getEnergyStats(options, today, today.year);
        const previous = await getEnergyStats(options, prevMonth, today.year - 1);

        const byKey = new Map<string, number>();
        const key = (s: EnergyStat) =>
            s.day ? `${s.year}-${pad2(s.month)}-${pad2(s.day)}` : `${s.year}-${pad2(s.month)}`;
        for (const s of [...current.days, ...previous.days, ...current.months, ...previous.months]) {
            byKey.set(key(s), s.wh);
        }

        // Walk back in UTC so local DST changes can't skip or repeat a calendar day.
        const todayMs = Date.UTC(today.year, today.month - 1, today.day);
        const days: [string, number][] = [];
        for (let i = 0; i < HISTORY_DAYS; i++) {
            const d = new Date(todayMs - i * DAY_MS);
            const k = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
            days.push([k, byKey.get(k) ?? 0]);
        }
        const months: [string, number][] = [];
        for (let i = 0; i < HISTORY_MONTHS; i++) {
            const m = new Date(Date.UTC(today.year, today.month - 1 - i, 1));
            const k = `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}`;
            months.push([k, byKey.get(k) ?? 0]);
        }
        return { todayWh: days[0][1], monthWh: months[0][1], days, months };
    }

    async turnOn(): Promise<void> {
        await this.callIot({ system: { set_relay_state: { state: 1 } } });
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.callIot({ system: { set_relay_state: { state: 0 } } });
        this.on = false;
    }

    protected async refreshStateInternal(): Promise<void> {
        const sys = await getSysInfo(this.iotOptions());
        if (!sys) return;
        if (typeof sys.relay_state === 'number') this.update('on', sys.relay_state === 1);
        // Energy-monitoring capability is advertised in sysinfo.feature as "ENE"
        // (e.g. "TIM:ENE"). Cache the boolean so the Readme tab knows whether to
        // bother fetching live wattage.
        const hasEmeter = /ENE/i.test(typeof sys.feature === 'string' ? sys.feature : '');
        if (this.storageSettings.values.hasEmeter !== hasEmeter) {
            this.storageSettings.values.hasEmeter = hasEmeter;
        }
        if (typeof sys.led_off === 'number') this.ledOff = sys.led_off === 1;
        // Subclasses with extra state extend via onSysInfo hook.
        this.onSysInfo(sys);
    }

    // Hook for subclasses to consume additional sysinfo fields (e.g. brightness for dimmers).
    protected onSysInfo(_sys: Record<string, any>): void {}
}
