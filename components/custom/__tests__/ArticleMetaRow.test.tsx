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
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
// SourceCountryFlag pulls in the popover ESM (un-transformable under jest-expo).
jest.mock('@/components/custom/SourceCountryFlag', () => ({ SourceCountryFlag: () => null }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
jest.mock('@/lib/translation-service', () => ({
  getArticleTranslatableStatus: () => 'translatable',
}));
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

  it('title-cases the publication name without mangling initialisms', () => {
    const { getByText: getShouty } = render(
      <ArticleMetaRow variant="card" {...base} publicationName="globoesporte.com" />,
    );
    expect(getShouty('Globoesporte.com')).toBeTruthy();

    const { getByText: getAcronym } = render(
      <ArticleMetaRow variant="card" {...base} publicationName="NDTV" />,
    );
    expect(getAcronym('NDTV')).toBeTruthy();
  });

  it('names the article language in the reader\'s language, not its endonym', () => {
    const { getByText } = render(<ArticleMetaRow variant="card" {...base} />);
    expect(getByText('German')).toBeTruthy();
  });
});
