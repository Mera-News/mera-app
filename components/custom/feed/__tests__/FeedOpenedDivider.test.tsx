// FeedOpenedDivider — render coverage for the Feed's SECOND divider (the
// seen-but-not-opened / opened boundary).
//
// The divider's PLACEMENT is covered exhaustively by the pure `buildFeedRows`
// tests in feed-entries.test.ts. What those cannot catch is the component
// itself failing to render — a missing i18n key, or a UI primitive that throws —
// because the sentinel is just a string in that layer. This file closes that
// gap, and asserts the real en.json keys resolve rather than falling back.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Resolves against the REAL en.json, so a missing/renamed key fails here
    // instead of silently rendering the raw key path on screen.
    t: (key: string) => {
      const en = require('@/lib/locales/en.json');
      return key.split('.').reduce<any>((acc, part) => acc?.[part], en) ?? key;
    },
  }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import FeedOpenedDivider from '../FeedOpenedDivider';
import en from '@/lib/locales/en.json';

describe('FeedOpenedDivider', () => {
  it('renders the title and subtitle from the real en.json keys', () => {
    render(<FeedOpenedDivider />);
    expect(screen.getByText(en.feed.divider.openedTitle)).toBeTruthy();
    expect(screen.getByText(en.feed.divider.openedSubtitle)).toBeTruthy();
  });

  it('carries the testID the harness targets', () => {
    render(<FeedOpenedDivider />);
    expect(screen.getByTestId('feed-divider-opened')).toBeTruthy();
  });

  it('the en.json copy exists and is distinguishable from divider #1', () => {
    // The two dividers must not read alike — that is the whole reason there are
    // two of them rather than one.
    expect(en.feed.divider.openedTitle).toBeTruthy();
    expect(en.feed.divider.caughtUpSubtitle).toBeTruthy();
    expect(en.feed.divider.openedTitle).not.toBe(en.feed.allCaughtUp);
    expect(en.feed.divider.openedSubtitle).not.toBe(en.feed.divider.caughtUpSubtitle);
  });
});
