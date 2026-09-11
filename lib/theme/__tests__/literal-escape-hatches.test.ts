// P2's contract: the literal escape hatches are byte-identical to the Tailwind
// values they replace, in BOTH schemes.
//
// That is what makes P2 a zero-pixel change today. `text-pure-black` renders
// exactly what `text-black` rendered; the difference only starts to matter in
// P3, when the `white`/`black` aliases are repointed at themed values and these
// sites correctly opt OUT of that.
//
// If a future change makes pure-black anything but 0 0 0, it has stopped being
// an escape hatch and every on-accent label silently moves.

import { rawTokens } from '@/components/ui/gluestack-ui-provider/config';

const TAILWIND_WHITE = '255 255 255';
const TAILWIND_BLACK = '0 0 0';

describe('literal escape hatches', () => {
  it.each(['light', 'dark'] as const)('%s: pure-white is Tailwind white', (scheme) => {
    expect(rawTokens[scheme]['--color-pure-white']).toBe(TAILWIND_WHITE);
  });

  it.each(['light', 'dark'] as const)('%s: pure-black is Tailwind black', (scheme) => {
    expect(rawTokens[scheme]['--color-pure-black']).toBe(TAILWIND_BLACK);
  });

  it('does not change between schemes, which is the whole point', () => {
    for (const key of ['--color-pure-white', '--color-pure-black', '--color-scrim'] as const) {
      expect(rawTokens.light[key]).toBe(rawTokens.dark[key]);
    }
  });

  it('the scrim is dark in both schemes, because photographs are not lighter in light mode', () => {
    expect(rawTokens.light['--color-scrim']).toBe(TAILWIND_BLACK);
  });
});

describe('on-accent labels', () => {
  // Regression pin. The plan said to migrate text-black to text-typography-950.
  // In DARK that token is near-white, so all 19 accent-button labels would have
  // flipped to white at 2.55:1 on the Almond fill — an AA failure and a visible
  // dark-mode change. pure-black is 8.16:1 and identical to what ships today.
  it('typography-950 is near-white in dark, so it is NOT the on-accent label', () => {
    const [r] = rawTokens.dark['--color-typography-950'].split(' ').map(Number);
    expect(r).toBeGreaterThan(200);
  });

  it('pure-black is the on-accent label and is genuinely black', () => {
    expect(rawTokens.dark['--color-pure-black']).toBe(TAILWIND_BLACK);
  });
});
