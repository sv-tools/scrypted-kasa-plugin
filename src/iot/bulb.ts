import { Brightness, ColorHsv, ColorSettingHsv, ColorSettingTemperature, OnOff } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { IOT_NETWORK_SETTINGS, KasaIotBase } from './base';
import { getSysInfo } from './protocol';

// Smart bulbs (LB100/110/120/130, KL110/120/130/135/...). All bulb state — on/off,
// brightness, hue, saturation, color temperature — is controlled by a single command:
//   {"smartlife.iot.smartbulb.lightingservice":{"transition_light_state":{...}}}
//
// Capability flags from sysinfo:
//   is_dimmable           1 = supports brightness
//   is_color              1 = supports hue/saturation
//   is_variable_color_temp 1 = supports color temperature
// Color temperature range is determined per-model; we expose the values the bulb returns
// in `getTemperatureMinK`/`getTemperatureMaxK` and fall back to a safe pair otherwise.
export class KasaBulb extends KasaIotBase implements OnOff, Brightness, ColorSettingHsv, ColorSettingTemperature {
    storageSettings = new StorageSettings(this, {
        ...IOT_NETWORK_SETTINGS,
        // Capability flags captured from sysinfo at adoption — internal only, drive which
        // interfaces the device advertises. Hidden because users don't typically need to
        // toggle them (auto-detected from the bulb's own metadata).
        isColor: {
            type: 'boolean',
            hide: true,
        },
        isVariableColorTemp: {
            type: 'boolean',
            hide: true,
        },
        colorTemperatureMinK: {
            type: 'number',
            defaultValue: 2700,
            hide: true,
        },
        colorTemperatureMaxK: {
            type: 'number',
            defaultValue: 6500,
            hide: true,
        },
    });

    // Per-device Readme tab. Adds the static capability list (color / color-temp range), since
    // those depend on per-model sysinfo flags.
    async getReadmeMarkdown(): Promise<string> {
        const { isColor, isVariableColorTemp, colorTemperatureMinK, colorTemperatureMaxK } =
            this.storageSettings.values;

        const capabilities: string[] = ['Brightness'];
        if (isColor) capabilities.push('Color (HSV)');
        if (isVariableColorTemp)
            capabilities.push(`Color temperature (${colorTemperatureMinK}–${colorTemperatureMaxK} K)`);

        return [
            ...this.readmeDeviceSection('Kasa Bulb'),
            '## Capabilities',
            '',
            ...capabilities.map(c => `- ${c}`),
            '',
            '## Protocol',
            '',
            `Local TCP/${this.readmePort} — Kasa's legacy "smarthome" wire format. All bulb state changes`,
            'are issued via `smartlife.iot.smartbulb.lightingservice.transition_light_state`.',
        ].join('\n');
    }

    async turnOn(): Promise<void> {
        await this.lightState({ on_off: 1 });
        this.on = true;
    }

    async turnOff(): Promise<void> {
        await this.lightState({ on_off: 0 });
        this.on = false;
    }

    async setBrightness(brightness: number): Promise<void> {
        await this.lightState({ brightness });
        this.brightness = brightness;
    }

    async setHsv(hue: number, saturation: number, value: number): Promise<void> {
        // Switch the bulb to color mode (mode 1) when HSV is set; without this some bulbs
        // ignore the hue/saturation while in color-temperature mode.
        await this.lightState({
            color_temp: 0,
            hue,
            saturation,
            brightness: value,
        });
        this.hsv = { h: hue, s: saturation, v: value };
        this.brightness = value;
    }

    async setColorTemperature(kelvin: number): Promise<void> {
        await this.lightState({ color_temp: kelvin });
        this.colorTemperature = kelvin;
    }

    async getTemperatureMinK(): Promise<number> {
        return this.storageSettings.values.colorTemperatureMinK;
    }

    async getTemperatureMaxK(): Promise<number> {
        return this.storageSettings.values.colorTemperatureMaxK;
    }

    protected async refreshStateInternal(): Promise<void> {
        const sys = await getSysInfo(this.iotOptions());
        const ls = sys?.light_state;
        if (!ls) return;
        // light_state during off-state nests the actual values under `dft_on_state`.
        const active = ls.on_off ? ls : ls.dft_on_state || {};
        this.update('on', ls.on_off === 1);
        if (typeof active.brightness === 'number') this.update('brightness', active.brightness);
        if (typeof active.color_temp === 'number') this.update('colorTemperature', active.color_temp);
        if (typeof active.hue === 'number' && typeof active.saturation === 'number') {
            const hsv: ColorHsv = {
                h: active.hue,
                s: active.saturation,
                v: typeof active.brightness === 'number' ? active.brightness : 100,
            };
            const prev = this.hsv;
            if (prev?.h !== hsv.h || prev?.s !== hsv.s || prev?.v !== hsv.v) this.hsv = hsv;
        }
    }

    private lightState(state: Record<string, any>): Promise<any> {
        // ignore_default tells the bulb to merge with current state instead of resetting.
        return this.callIot({
            'smartlife.iot.smartbulb.lightingservice': {
                transition_light_state: { ignore_default: 1, ...state },
            },
        });
    }
}
