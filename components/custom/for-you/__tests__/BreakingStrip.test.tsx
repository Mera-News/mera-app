/* eslint-disable @typescript-eslint/no-require-imports */
// BreakingStrip.test — the strip is the loudest surface in the app, so what it
// SAYS and how prominent it is are product decisions, not styling details.
//
// Membership ("only EMERGENCY-band stories reach here at all") is enforced one
// layer up and covered by `fact-rows-selector.test` — this file guards the two
// things a future edit to this component could quietly undo.

import { render } from '@testing-library/react-native';
import React from 'react';
import type { BreakingCardData } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-runtime');
  return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  const ReactJSXRuntime = require('react/jsx-dev-runtime');
  return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

// `t` echoes the key, so an assertion on rendered text is an assertion on WHICH
// key the component reaches for.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text }: { text: string }) => <Text>{text}</Text>,
  };
});

import BreakingStrip from '../BreakingStrip';

const item = (id: string, title: string): BreakingCardData => ({
  data: { _id: id, title_en: title } as unknown as ForYouSuggestion,
  members: [],
});

describe('BreakingStrip', () => {
  it('renders nothing when there are no items', () => {
    const { toJSON } = render(<BreakingStrip items={[]} onPressItem={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });

  it('labels the chip from `relevance.emergency`, the same key the band uses everywhere else', () => {
    // NOT `forYou.breaking`. The strip gates on the EMERGENCY band, so it must
    // say what that band is called in the importance dial and the section
    // headers — one concept, one string. The old "Breaking" wording is exactly
    // how the label drifted away from what the strip actually gated on.
    const { getByText } = render(
      <BreakingStrip items={[item('a', 'Dam breach forces evacuation')]} onPressItem={jest.fn()} />,
    );
    expect(getByText('relevance.emergency'.toUpperCase())).toBeTruthy();
    expect(() => getByText('forYou.breaking'.toUpperCase())).toThrow();
  });

  it('gives the card enough width to show a real headline', () => {
    // Widened from 280/200. Asserted as a floor rather than an exact pair: the
    // requirement is "wide enough to read", and pinning exact points would make
    // any future tuning look like a regression.
    const { getByRole } = render(
      <BreakingStrip items={[item('a', 'Dam breach forces evacuation')]} onPressItem={jest.fn()} />,
    );
    const style = getByRole('button').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;
    expect(flat.maxWidth).toBeGreaterThanOrEqual(320);
    expect(flat.minWidth).toBeGreaterThanOrEqual(260);
  });
});
