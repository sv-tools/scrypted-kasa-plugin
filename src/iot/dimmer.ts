import { Brightness } from '@scrypted/sdk';
import { KasaIotDevice } from './device';

// Dimmable Kasa devices (HS220 dimmer plug, KS230 3-way dimmer switch, etc.). Same
// relay protocol as KasaPlug/KasaSwitch plus a brightness command:
//   {"smartlife.iot.dimmer":{"set_brightness":{"brightness":N}}}
//
// Always exposed as `Light` since these are essentially always wired to a light fixture
// (the Kasa app does the same). On/off uses the relay; brightness uses the dimmer module.
export class KasaDimmer extends KasaIotDevice implements Brightness {
    async setBrightness(brightness: number): Promise<void> {
        const level = Math.round(Math.min(100, Math.max(0, brightness)));
        // Kasa dimmers accept 1..100 for set_brightness; dimming to 0 turns the relay off.
        if (level <= 0) {
            await this.turnOff();
            return;
        }
        await this.callIot({ 'smartlife.iot.dimmer': { set_brightness: { brightness: level } } });
        this.brightness = level;
    }

    protected onSysInfo(sys: Record<string, any>): void {
        if (typeof sys.brightness === 'number') this.update('brightness', sys.brightness);
    }
}
