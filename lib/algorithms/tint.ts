/**
 * A token colour at another alpha, as rgba(): `tint(c.accent, 0.14)` for a
 * picked row, `tint(c.ink, 0.3)` for an edge. Accepts #RGB, #RRGGBB, rgb() and
 * rgba() (an rgba's own alpha is replaced, not multiplied). Anything else is
 * returned unchanged rather than guessed.
 */
export function tint(colour: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
    if (hex) {
        const h = hex[1].length === 3 ? hex[1].replace(/./g, (x) => x + x) : hex[1];
        const n = parseInt(h, 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(colour.trim());
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`;
    return colour;
}
