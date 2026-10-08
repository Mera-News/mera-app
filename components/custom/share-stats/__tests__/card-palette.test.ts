import { COLORS } from '@/lib/theme/tokens';

import { CARD_PALETTES, inAppCardPalette } from '../card-theme';

describe('inAppCardPalette', () => {
  it("follows the app's theme, so light Stats cards get dark ink", () => {
    expect(inAppCardPalette('light')).toBe(CARD_PALETTES.light);
    expect(inAppCardPalette('light').primary).toBe(COLORS.light.ink);
    expect(inAppCardPalette('dark')).toBe(CARD_PALETTES.dark);
  });
});
