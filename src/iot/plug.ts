import { KasaIotDevice } from './device';

// Plain Kasa plugs/outlets (HS100/HS103/HS105/HS107/HS110/KP100/etc.) — single relay,
// no brightness. Dimmer plugs (HS220) are handled by KasaDimmer instead.
export class KasaPlug extends KasaIotDevice {}
