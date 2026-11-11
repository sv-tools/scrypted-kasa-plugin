import net from 'net';
import { xorDecryptInPlace, xorEncryptInPlace } from '../shared/cipher';

// Legacy Kasa "IOT" protocol used by plugs, switches, and bulbs (everything that isn't a
// camera). Wire format on TCP/9999:
//   4-byte big-endian length prefix + XOR-AB(plaintext-json) bytes
// Same XOR-AB autokey cipher as UDP discovery; the only difference is the framing.
//
// Same-port UDP/9999 also accepts the encrypted JSON without the 4-byte prefix, but TCP
// is more reliable for control commands so we use it exclusively here.

export const KASA_IOT_PORT = 9999;
const REQUEST_TIMEOUT_MS = 5000;

export interface KasaIotOptions {
    host: string;
    port?: number;
    timeoutMs?: number;
}

export async function kasaIotCall(options: KasaIotOptions, command: Record<string, any>): Promise<any> {
    const port = options.port || KASA_IOT_PORT;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const json = JSON.stringify(command);
    // Encode the 4-byte length prefix and JSON in one allocation, encrypt the JSON portion
    // in-place (we own this buffer and don't read the plaintext again).
    const jsonBytes = Buffer.byteLength(json, 'utf8');
    const payload = Buffer.allocUnsafe(4 + jsonBytes);
    payload.writeUInt32BE(jsonBytes, 0);
    payload.write(json, 4, 'utf8');
    xorEncryptInPlace(payload.subarray(4));

    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        // Received TCP chunks, joined once when the whole reply is in (bulb light_state replies
        // span 2-3 chunks) rather than on every 'data' event.
        const chunks: Buffer[] = [];
        let queuedBytes = 0;
        let expected = -1;
        let settled = false;

        const finish = (err?: Error, value?: any) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.destroy();
            } catch {}
            // Drop references so any retained chunks can be GC'd promptly.
            chunks.length = 0;
            if (err) reject(err);
            else resolve(value);
        };

        const timer = setTimeout(() => finish(new Error(`kasa iot call timeout after ${timeoutMs}ms`)), timeoutMs);

        socket.on('data', (chunk: Buffer) => {
            if (settled) return;
            chunks.push(chunk);
            queuedBytes += chunk.length;
            if (queuedBytes < 4) return;
            // The 4-byte length prefix almost always arrives whole in the first chunk.
            if (expected < 0) expected = (chunks[0].length >= 4 ? chunks[0] : Buffer.concat(chunks)).readUInt32BE(0);
            if (queuedBytes < 4 + expected) return;
            // The joined buffer is ours alone, so decrypt it in place.
            const cipher = Buffer.concat(chunks, queuedBytes).subarray(4, 4 + expected);
            try {
                finish(undefined, JSON.parse(xorDecryptInPlace(cipher).toString('utf8')));
            } catch (e) {
                finish(e as Error);
            }
        });

        socket.on('error', e => finish(e));
        socket.on('close', () => {
            if (!settled) finish(new Error('kasa iot socket closed before response'));
        });

        socket.connect(port, options.host, () => {
            socket.write(payload);
        });
    });
}

// Common helpers used by both plugs/switches and bulbs.

export interface KasaSysInfoCommon {
    alias?: string;
    model?: string;
    mac?: string;
    mic_mac?: string;
    deviceId?: string;
    sw_ver?: string;
    hw_ver?: string;
    type?: string;
    mic_type?: string;
    dev_name?: string;
    feature?: string;
    [k: string]: any;
}

export async function getSysInfo(options: KasaIotOptions): Promise<KasaSysInfoCommon | undefined> {
    const r = await kasaIotCall(options, { system: { get_sysinfo: {} } });
    return r?.system?.get_sysinfo;
}

// Energy-monitoring readout for plugs that report sysinfo.feature containing "ENE"
// (HS110, KP115, KP125, EP25, HS220, ...). The plug answers `emeter.get_realtime` with
// either the newer milli-units schema or the older base-unit schema:
//
//   newer:  { voltage_mv, current_ma, power_mw, total_wh, err_code }
//   older:  { voltage,    current,    power,    total,    err_code }   // V, A, W, kWh
//
// Normalize to a single V/A/W/Wh shape so callers don't care which schema the device uses.
// Returns undefined on err_code or when neither schema matches.
export interface EmeterReading {
    voltageV: number;
    currentA: number;
    powerW: number;
    totalWh: number;
}

export async function getEmeterRealtime(options: KasaIotOptions): Promise<EmeterReading | undefined> {
    const r = await kasaIotCall(options, { emeter: { get_realtime: {} } });
    const e = r?.emeter?.get_realtime;
    if (!e || e.err_code) return undefined;
    if (typeof e.voltage_mv === 'number') {
        return {
            voltageV: e.voltage_mv / 1000,
            currentA: (e.current_ma ?? 0) / 1000,
            powerW: (e.power_mw ?? 0) / 1000,
            totalWh: e.total_wh ?? 0,
        };
    }
    if (typeof e.voltage === 'number') {
        return {
            voltageV: e.voltage,
            currentA: e.current ?? 0,
            powerW: e.power ?? 0,
            totalWh: (e.total ?? 0) * 1000,
        };
    }
    return undefined;
}

// The plug's own local date. Energy history below is keyed by it, so "today" has to come from
// here rather than the host clock, which may be in another time zone or off by a few minutes
// around midnight.
export interface PlugDate {
    year: number;
    month: number;
    day: number;
}

export async function getPlugDate(options: KasaIotOptions): Promise<PlugDate | undefined> {
    const r = await kasaIotCall(options, { time: { get_time: {} } });
    const t = r?.time?.get_time;
    if (!t || t.err_code || typeof t.year !== 'number') return undefined;
    return { year: t.year, month: t.month, day: t.mday };
}

// Daily and monthly energy totals the plug keeps itself (the Kasa app's usage charts). One
// request carries both: get_daystat for one month and get_monthstat for one year. Days and
// months without usage are left out of the lists. Totals come as energy_wh, or as `energy` in
// kWh on devices that use the base-unit schema of get_realtime.
export interface EnergyStat {
    year: number;
    month: number;
    day?: number;
    wh: number;
}

export async function getEnergyStats(
    options: KasaIotOptions,
    days: { year: number; month: number },
    monthsOfYear: number,
): Promise<{ days: EnergyStat[]; months: EnergyStat[] }> {
    const r = await kasaIotCall(options, {
        emeter: { get_daystat: { year: days.year, month: days.month }, get_monthstat: { year: monthsOfYear } },
    });
    return {
        days: parseEnergyStats(r?.emeter?.get_daystat, 'day_list'),
        months: parseEnergyStats(r?.emeter?.get_monthstat, 'month_list'),
    };
}

function parseEnergyStats(result: any, listKey: string): EnergyStat[] {
    if (!result || result.err_code || !Array.isArray(result[listKey])) return [];
    const stats: EnergyStat[] = [];
    for (const e of result[listKey]) {
        const wh =
            typeof e?.energy_wh === 'number'
                ? e.energy_wh
                : typeof e?.energy === 'number'
                  ? e.energy * 1000
                  : undefined;
        if (wh === undefined || typeof e.year !== 'number' || typeof e.month !== 'number') continue;
        stats.push({ year: e.year, month: e.month, day: typeof e.day === 'number' ? e.day : undefined, wh });
    }
    return stats;
}
