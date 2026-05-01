// Shared formatting helpers for the per-device + plugin-level Readme tabs. Scrypted's
// markdown renderer is plain CommonMark — it doesn't recognize GFM pipe tables, so we
// render tabular data inside fenced code blocks with manual column padding.

// Format a hex MAC (e.g. "F0090D49721F") with colon separators (e.g. "F0:09:0D:49:72:1F").
// Returns the input unchanged if it isn't a 12-character hex string — Kasa devices
// occasionally surface MACs in already-colon-formatted form, and we don't want to mangle
// either case.
export function formatKasaMac(mac: string | undefined): string {
    if (!mac) return '?';
    if (!/^[0-9A-Fa-f]{12}$/.test(mac)) return mac;
    return mac.match(/.{2}/g)!.join(':').toUpperCase();
}

// Render a list of [label, value] pairs as a left-padded plain-text block. Caller is
// expected to wrap the output in triple-backtick fences so monospace alignment renders.
export function renderKv(rows: [string, string][]): string {
    const labelWidth = Math.max(...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `${k.padEnd(labelWidth)}  ${v}`).join('\n');
}
