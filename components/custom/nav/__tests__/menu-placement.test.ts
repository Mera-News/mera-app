import { menuTop } from '../menu-placement';

const base = {
  chipHeight: 34,
  panelHeight: 142,
  windowHeight: 874,
  safeTop: 62,
  safeBottom: 34,
  gap: 6,
};

describe('menuTop', () => {
  it('opens under the chip when it fits', () => {
    expect(menuTop({ ...base, chipTop: 120 })).toBe(160);
  });

  it('opens above the chip near the bottom (Related sort at y 716)', () => {
    expect(menuTop({ ...base, chipTop: 716 })).toBe(716 - 6 - 142);
  });

  it('uses the last point that still fits below, exactly', () => {
    const chipTop = 874 - 34 - 142 - 6 - 34;
    expect(menuTop({ ...base, chipTop })).toBe(chipTop + 34 + 6);
  });

  it('clamps inside the safe area when it fits neither way', () => {
    const tall = { ...base, panelHeight: 700 };
    const top = menuTop({ ...tall, chipTop: 300 });
    expect(top).toBeGreaterThanOrEqual(62);
    expect(top + 700).toBeLessThanOrEqual(874 - 34);
  });

  it('pins to the safe top when the panel is taller than the safe area', () => {
    expect(menuTop({ ...base, panelHeight: 900, chipTop: 300 })).toBe(62);
  });
});
