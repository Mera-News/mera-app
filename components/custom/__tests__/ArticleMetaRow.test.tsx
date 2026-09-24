// ArticleMetaRow tests — the NEW-badge gating fix (r6 P4): a card shows NEW only
// when it is a card variant, fresh, AND unread (read wins over NEW). Heavy leaf
// deps (SourceFlag, translation/language helpers, time-ago) are stubbed to plain
// values so the row renders under jest-expo.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: any) => (opts?.count != null ? `${key}:${opts.count}` : key) }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
// Icons draw their real icon-font glyph, as on device (see icon-glyph-a11y).
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
// SourceCountryFlag pulls in the popover ESM (un-transformable under jest-expo).
jest.mock('@/components/custom/SourceCountryFlag', () => ({ SourceCountryFlag: () => null }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
let mockStatus = 'translatable';
let mockBlocked: string | null = null;
jest.mock('@/lib/translation-service', () => ({
  getArticleTranslatableStatus: () => mockStatus,
  useTranslationBlocked: () => mockBlocked,
}));
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
// The failed-translation affordance uses the gluestack Tooltip, which pulls in
// @legendapp/motion and, through it, RN's Animated internals — more than this
// suite mounts react-native for. The tooltip's own behaviour is not under test
// here.
jest.mock('@/components/ui/tooltip', () => {
  const { View, Text } = require('react-native');
  return {
    Tooltip: ({ trigger }: any) => trigger({}),
    TooltipContent: (p: any) => <View {...p} />,
    TooltipText: (p: any) => <Text {...p} />,
  };
});

jest.mock('@/lib/language-names', () => ({
  getLocalizedLanguageName: (code: string | null | undefined) => (code ? 'German' : ''),
}));
jest.mock('@/lib/utils/time-ago', () => ({ formatTimeAgo: () => '2h' }));

import { render } from '@testing-library/react-native';
import React from 'react';
import { ArticleMetaRow } from '../ArticleMetaRow';

const base = {
  pubDate: new Date().toISOString(),
  languageCode: 'de',
  publicationName: 'Der Spiegel',
  countryCode: 'DE',
} as const;

describe('ArticleMetaRow', () => {
  it('shows the NEW badge on a fresh, unread card', () => {
    const { queryByText } = render(<ArticleMetaRow variant="card" isNew {...base} />);
    expect(queryByText('feed.newBadge')).toBeTruthy();
  });

  it('suppresses the NEW badge on a read card (read wins)', () => {
    const { queryByText } = render(<ArticleMetaRow variant="card" isNew read {...base} />);
    expect(queryByText('feed.newBadge')).toBeNull();
  });

  it('never shows the NEW badge on the screen variant', () => {
    const { queryByText } = render(<ArticleMetaRow variant="screen" isNew {...base} />);
    expect(queryByText('feed.newBadge')).toBeNull();
  });

  // The eye glyph is deliberately gone: `read` drives the "All caught up"
  // partition and the NEW-badge suppression, but is never drawn to the user.
  it('renders NO read indicator when read', () => {
    const { UNSAFE_queryAllByProps } = render(<ArticleMetaRow variant="card" read {...base} />);
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: 'read' })).toHaveLength(0);
  });

  it('renders NO read indicator on the screen variant either', () => {
    const { UNSAFE_queryAllByProps } = render(<ArticleMetaRow variant="screen" read {...base} />);
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: 'read' })).toHaveLength(0);
  });

  it('still renders the age when read — hiding the eye must not hide the row', () => {
    const { getByText } = render(<ArticleMetaRow variant="card" read {...base} />);
    expect(getByText('2h')).toBeTruthy(); // formatTimeAgo is stubbed to '2h'
  });

  it('renders the publication name (single line)', () => {
    const { getByText } = render(<ArticleMetaRow variant="card" {...base} />);
    expect(getByText('Der Spiegel')).toBeTruthy();
  });

  // Owner decision: publication names are shown EXACTLY as stored on cards
  // too (no title-casing), the same rule as detail.
  it.each(['card', 'screen'] as const)('%s: shows the publication exactly as stored', (variant) => {
    for (const name of ['globoesporte.com', 'NDTV', 'Instituto Nacional de Ciberseguridad (INCIBE)']) {
      const { getByText, unmount } = render(<ArticleMetaRow variant={variant} {...base} publicationName={name} />);
      expect(getByText(name)).toBeTruthy();
      unmount();
    }
  });

  // Batch 9: detail showed "Instituto Nacional De Ciberseguridad (Incibe)".
  // On the detail screen the name is shown exactly as stored.
  it('shows the publication exactly as stored on the detail screen', () => {
    const { getByText } = render(
      <ArticleMetaRow variant="screen" {...base} publicationName="Instituto Nacional de Ciberseguridad (INCIBE)" />,
    );
    expect(getByText('Instituto Nacional de Ciberseguridad (INCIBE)')).toBeTruthy();
  });

  it('names the article language in the reader\'s language, not its endonym', () => {
    const { getByText } = render(<ArticleMetaRow variant="card" {...base} />);
    expect(getByText('German')).toBeTruthy();
  });
});

// Owner spec: language pinned left, the publication CENTRED (growing
// symmetrically, capped, trimmed on the right), flag and time pinned right.
// Every side segment shows in full. The detail row once showed
// "National Cyber Security Centre (NCSC) · 22h ago · Dutc".
describe('ArticleMetaRow layout (owner spec)', () => {
  const flat = (st: any) => [st].flat(Infinity).reduce((a: any, x: any) => ({ ...a, ...(x ?? {}) }), {});
  const LONG = 'National Cyber Security Centre (NCSC) of the Kingdom of Spain';

  // Owner revision: |📰 De Telegraaf        🕒 22h        🇳🇱 Dutch|
  // publication LEFT (trims right), time CENTRED between equal-flex columns,
  // flag + language RIGHT; card, Saved and detail alike.
  it.each(['card', 'screen'] as const)('%s: publication left, time centred, flag and language right', (variant) => {
    const { getByTestId } = render(<ArticleMetaRow variant={variant} {...base} />);
    expect(flat(getByTestId('meta-left').props.style).flex).toBe(1);
    expect(flat(getByTestId('meta-right').props.style).flex).toBe(1);
    const within = (root: any, id: string) => root.findAll((n: any) => n.props?.testID === id).length > 0;
    expect(within(getByTestId('meta-left'), 'meta-publication-slot')).toBe(true);
    expect(within(getByTestId('meta-right'), 'meta-language-slot')).toBe(true);
    // The time sits between the columns, never inside one.
    expect(within(getByTestId('meta-left'), 'meta-age-slot')).toBe(false);
    expect(within(getByTestId('meta-right'), 'meta-age-slot')).toBe(false);
    expect(flat(getByTestId('meta-age-slot').props.style).flexShrink).toBe(0);
    expect(getByTestId('meta-right').findAll((n: any) => n.props?.name === 'translate')).toHaveLength(0);
  });

  it.each(['card', 'screen'] as const)('%s: a 60-char publication trims on the right inside its column', (variant) => {
    const { getByTestId, getByText } = render(
      <ArticleMetaRow variant={variant} {...base} publicationName={LONG} />,
    );
    const name = getByText(/National Cyber Security Centre/);
    expect(name.props.numberOfLines).toBe(1);
    expect(name.props.ellipsizeMode).toBe('tail');
    expect(flat(getByTestId('meta-publication-slot').props.style).minWidth).toBe(0);
    expect(flat(getByTestId('meta-language-slot').props.style).flexShrink).toBe(0);
  });

  it('draws no translate glyph even when translation failed (owner decision)', () => {
    mockStatus = 'translatable';
    mockBlocked = 'blocked';
    const { getByTestId, queryByTestId } = render(<ArticleMetaRow variant="card" {...base} />);
    expect(queryByTestId('meta-translate-failed')).toBeNull();
    expect(getByTestId('meta-right').findAll((n: any) => n.props?.name === 'translate')).toHaveLength(0);
    mockBlocked = null;
  });

  // Owner: with no time on the left (Feed cards), the publication sits at the
  // LEFT edge instead of centred, takes the remaining width and trims right.
  it('Feed (no time): publication left-aligned, flag and language right', () => {
    const { getByTestId, queryByTestId, getByText } = render(
      <ArticleMetaRow variant="card" {...base} showRecency={false} />,
    );
    expect(queryByTestId('meta-left')).toBeNull();
    expect(queryByTestId('meta-age-slot')).toBeNull();
    const slot = flat(getByTestId('meta-publication-slot').props.style);
    expect(slot.flex).toBe(1);
    expect(slot.minWidth).toBe(0);
    expect(flat(getByText('Der Spiegel').props.style).textAlign).toBe('left');
    const ids = (getByTestId('meta-row') as any)
      .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
      .map((n: any) => n.props.testID);
    expect(ids.indexOf('meta-publication-slot')).toBeLessThan(ids.indexOf('meta-language-slot'));
  });

  it('shows the language on every card, the reader\'s own language included', () => {
    const { getByTestId } = render(<ArticleMetaRow variant="card" {...base} languageCode="en" />);
    expect(getByTestId('meta-language-slot')).toBeTruthy();
  });

  it.each([null, 'blocked'])('compact rows draw no translate glyph (translation blocked: %s)', (blocked) => {
    mockStatus = 'translatable';
    mockBlocked = blocked;
    const { queryByTestId, UNSAFE_root } = render(<ArticleMetaRow variant="card" {...base} publicationName={null} />);
    expect(queryByTestId('meta-translate-failed')).toBeNull();
    expect(UNSAFE_root.findAll((n: any) => n.props?.name === 'translate')).toHaveLength(0);
    mockBlocked = null;
  });

  it('compact rows put the flag immediately left of the language', () => {
    const { getByTestId } = render(<ArticleMetaRow variant="card" {...base} publicationName={null} />);
    const group = getByTestId('meta-flag-language');
    const ids = group.findAll((n: any) => typeof n.props?.testID === 'string').map((n: any) => n.props.testID);
    expect(ids).toContain('meta-flag');
    expect(ids.indexOf('meta-flag')).toBeLessThan(ids.indexOf('meta-language-slot'));
  });

  it('leaves compact rows (no publication) spread: time, chip, language', () => {
    const { queryByTestId } = render(
      <ArticleMetaRow variant="card" {...base} publicationName={null} showFlag={false} />,
    );
    expect(queryByTestId('meta-left')).toBeNull();
    expect(queryByTestId('meta-language-slot')).toBeTruthy();
  });
});
