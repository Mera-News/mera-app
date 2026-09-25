/* eslint-disable @typescript-eslint/no-require-imports */
// D5/B4: History is publishers the reader opened from Mera. It reloads when
// it becomes visible (sub-tab selected AND the tab focused), and an empty list
// keeps pull-to-refresh.
let mockRows: unknown[] = [];
const mockGet = jest.fn(() => Promise.resolve(mockRows));
let mockFocused = true;

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getTopVisitedPublications: () => mockGet(),
}));
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// A hand-rolled list that renders EVERY slot this component uses: header,
// rows, and the empty component when there are no rows. A mock that dropped
// ListEmptyComponent would make the empty-state assertion below vacuous.
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = jest.requireActual('react-native');
  const resolve = (C: any) =>
    ReactLib.isValidElement(C) ? C : typeof C === 'function' ? ReactLib.createElement(C) : null;
  return {
    __esModule: true,
    default: {
      FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ...rest }: any) =>
        ReactLib.createElement(
          View,
          rest,
          resolve(ListHeaderComponent),
          ...(data?.length
            ? data.map((item: any, index: number) =>
                ReactLib.createElement(View, { key: keyExtractor(item, index) }, renderItem({ item, index })),
              )
            : [resolve(ListEmptyComponent)]),
        ),
    },
  };
});
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => <Text testID={p.testID}>{`${p.title}|${p.body}`}</Text> };
});
jest.mock('../DrillDownHeader', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));

import { render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import VisitedPublicationsList from '../VisitedPublicationsList';

beforeEach(() => {
  mockRows = [];
  mockGet.mockClear();
  mockFocused = true;
});

describe('VisitedPublicationsList', () => {
  it('reloads when the tab regains focus with the sub-tab still selected (B4)', async () => {
    const view = render(<VisitedPublicationsList embedded active onBack={jest.fn()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    mockFocused = false;
    view.rerender(<VisitedPublicationsList embedded active onBack={jest.fn()} />);
    mockFocused = true;
    view.rerender(<VisitedPublicationsList embedded active onBack={jest.fn()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('says what the list is when empty, and keeps pull-to-refresh (D5)', async () => {
    render(<VisitedPublicationsList embedded active onBack={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('visited-publications-empty')).toBeTruthy());
    expect(screen.getByTestId('visited-publications-empty').props.children).toBe(
      'publicationVisits.emptyTitle|publicationVisits.noArticlesYet',
    );
    expect(screen.getByTestId('visited-publications-list').props.refreshControl).toBeTruthy();
  });

  it('reports its row count so the host can hide the share button', async () => {
    mockRows = [{ publicationName: 'NOS', countryCode: 'NL', visitCount: 2, lastVisitedAt: Date.now() }];
    const onCountChange = jest.fn();
    render(<VisitedPublicationsList embedded active onBack={jest.fn()} onCountChange={onCountChange} />);
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(1));
  });
});

// ux2 B3 window: History is mounted off-screen as a neighbour. It reads once
// while warm, so swiping in shows the rows at once, with no spinner.
describe('VisitedPublicationsList warmed off-screen (active=false)', () => {
  it('reads once while warm, and arriving shows the rows with no loading state', async () => {
    mockRows = [{ publicationName: 'NOS', countryCode: 'NL', visitCount: 2, lastVisitedAt: Date.now() }];
    const view = render(<VisitedPublicationsList embedded active={false} onBack={jest.fn()} />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('NOS')).toBeTruthy());
    view.rerender(<VisitedPublicationsList embedded active onBack={jest.fn()} />);
    // Same frame as the arrival: the rows, never the spinner or the empty state.
    expect(screen.getByText('NOS')).toBeTruthy();
    expect(screen.queryByTestId('visited-publications-empty')).toBeNull();
  });
});
