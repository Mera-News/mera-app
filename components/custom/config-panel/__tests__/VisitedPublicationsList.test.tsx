/* eslint-disable @typescript-eslint/no-require-imports */
// The Library's Visited page: merged ranking, the top card only for a clear
// leader, Subscribe/Support only with a subscribe page, "I already pay" only
// for a resolved publisher, "You pay" from local subscription rows, row tap to
// the publication page, and the reload-on-visible behaviour it always had.
let mockRows: unknown[] = [];
const mockGet = jest.fn(() => Promise.resolve(mockRows));
let mockFocused = true;
let mockResolved: Record<string, unknown> = {};
let mockSubs: { publisherName: string; sourceNamesJson: string | null; publisherId: string }[] = [];
const mockBegin = jest.fn();
const mockConfirmDirectly = jest.fn();
const mockOpenPage = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
    i18n: { language: 'en' },
  }),
}));
jest.mock('@/lib/database/services/publication-visit-service', () => ({
  getTopVisitedPublications: () => mockGet(),
}));
jest.mock('@/lib/subscriptions/publisher-lookup', () => ({
  resolvePublisherForSourceName: (name: string) => Promise.resolve(mockResolved[name] ?? null),
}));
jest.mock('@/components/custom/publication-preferences/use-subscribe-flow', () => ({
  useSubscribeFlow: () => ({
    subscriptions: { items: mockSubs },
    begin: mockBegin,
    confirmDirectly: mockConfirmDirectly,
    isSubscribed: (id: string) => mockSubs.some((s) => s.publisherId === id),
    confirming: null,
    onYes: jest.fn(),
    onNo: jest.fn(),
    onDismiss: jest.fn(),
  }),
}));
jest.mock('@/components/custom/publication-preferences/SubscribeConfirmDialog', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID="confirm-dialog" {...p} /> };
});
jest.mock('@/components/custom/publication-page/open-publication-page', () => ({
  openPublicationPage: (...a: unknown[]) => mockOpenPage(...a),
}));
jest.mock('@/lib/stores/publication-display-store', () => ({ useDisplayPublication: (n: string) => n }));
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// A hand-rolled list that renders EVERY slot this component uses: header,
// rows, footer, and the empty component when there are no rows. A mock that
// dropped a slot would make its absence assertions vacuous.
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = jest.requireActual('react-native');
  const resolve = (C: any) =>
    ReactLib.isValidElement(C) ? C : typeof C === 'function' ? ReactLib.createElement(C) : null;
  return {
    __esModule: true,
    default: {
      FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent, ...rest }: any) =>
        ReactLib.createElement(
          View,
          rest,
          resolve(ListHeaderComponent),
          ...(data?.length
            ? data.map((item: any, index: number) =>
                ReactLib.createElement(View, { key: keyExtractor(item, index) }, renderItem({ item, index })),
              )
            : [resolve(ListEmptyComponent)]),
          resolve(ListFooterComponent),
        ),
    },
  };
});
jest.mock('@/components/custom/for-you/ForYouEmptyState', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => <Text testID={p.testID}>{`${p.title}|${p.body}`}</Text> };
});
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
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

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import VisitedPublicationsList from '../VisitedPublicationsList';

const now = Date.UTC(2026, 8, 24, 12);
const row = (publicationName: string, visitCount: number, countryCode: string | null = null) => ({
  publicationName,
  countryCode,
  visitCount,
  lastVisitedAt: now,
});
const withUri = (name: string, id = `id-${name}`) => ({
  publisherId: id,
  publisherName: name,
  countryCode: 'DEU',
  subscriptionUri: `https://example.com/${id}`,
});
const tap = (el: any) => {
  fireEvent(el, 'pressIn', { nativeEvent: { pageX: 10, pageY: 10 } });
  fireEvent(el, 'press', { nativeEvent: { pageX: 11, pageY: 10 } });
};

beforeEach(() => {
  mockRows = [];
  mockResolved = {};
  mockSubs = [];
  mockGet.mockClear();
  mockBegin.mockClear();
  mockConfirmDirectly.mockClear();
  mockOpenPage.mockClear();
  mockFocused = true;
});

describe('VisitedPublicationsList: loading', () => {
  it('reloads when the tab regains focus with the page still selected', async () => {
    const view = render(<VisitedPublicationsList active />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    mockFocused = false;
    view.rerender(<VisitedPublicationsList active />);
    mockFocused = true;
    view.rerender(<VisitedPublicationsList active />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  });

  it('reads once while warm, and arriving shows the rows with no loading state', async () => {
    mockRows = [row('NOS', 2)];
    const view = render(<VisitedPublicationsList active={false} />);
    await waitFor(() => expect(screen.getByText('NOS')).toBeTruthy());
    view.rerender(<VisitedPublicationsList active />);
    expect(screen.getByText('NOS')).toBeTruthy();
    expect(screen.queryByTestId('visited-publications-empty')).toBeNull();
  });

  it('says what fills the page when empty, with no intro or footnote, and keeps pull-to-refresh', async () => {
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-publications-empty')).toBeTruthy());
    expect(screen.getByTestId('visited-publications-empty').props.children).toBe(
      'library.visited.emptyTitle|library.visited.emptyBody',
    );
    expect(screen.queryByTestId('visited-intro')).toBeNull();
    expect(screen.queryByTestId('visited-footnote')).toBeNull();
    expect(screen.getByTestId('visited-publications-list').props.refreshControl).toBeTruthy();
  });
});

describe('VisitedPublicationsList: ranking and the top card', () => {
  it('merges spellings before ranking, so the merged leader gets the top card', async () => {
    mockRows = [row('TechRadar', 4), row('Der Tagesspiegel', 3), row('DER TAGESSPIEGEL', 2, 'AUT')];
    render(<VisitedPublicationsList active />);
    const card = await waitFor(() => screen.getByTestId('visited-top-card'));
    expect(screen.getByTestId('visited-intro')).toBeTruthy();
    expect(screen.getByTestId('visited-footnote')).toBeTruthy();
    // 3 + 2 beats 4: the leader is the merged row, and it is not repeated below.
    expect(card).toHaveTextContent(/Der Tagesspiegel/);
    expect(screen.queryByTestId('visited-row-Der Tagesspiegel')).toBeNull();
    expect(screen.getByTestId('visited-row-TechRadar')).toBeTruthy();
  });

  it('shows no top card on a tie, and every row stays a row', async () => {
    mockRows = [row('A', 3), row('B', 3)];
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-row-A')).toBeTruthy());
    expect(screen.getByTestId('visited-row-B')).toBeTruthy();
    expect(screen.queryByTestId('visited-top-card')).toBeNull();
  });

  it('offers Subscribe and I already pay for a resolved leader with a subscribe page', async () => {
    mockRows = [row('DT', 3), row('NOS', 1)];
    mockResolved = { DT: withUri('DT') };
    render(<VisitedPublicationsList active />);
    const subscribe = await waitFor(() => screen.getByTestId('visited-top-subscribe'));
    fireEvent.press(subscribe);
    expect(mockBegin).toHaveBeenCalledWith(mockResolved.DT);
    fireEvent.press(screen.getByTestId('visited-top-already'));
    expect(mockConfirmDirectly).toHaveBeenCalledWith(mockResolved.DT);
  });

  it('offers only I already pay when the publisher resolves with no subscribe page', async () => {
    mockRows = [row('DT', 3)];
    mockResolved = { DT: { ...withUri('DT'), subscriptionUri: null } };
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-top-already')).toBeTruthy());
    expect(screen.queryByTestId('visited-top-subscribe')).toBeNull();
  });

  it('offers nothing when the publisher does not resolve', async () => {
    mockRows = [row('DT', 3)];
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-top-card')).toBeTruthy());
    expect(screen.queryByTestId('visited-top-subscribe')).toBeNull();
    expect(screen.queryByTestId('visited-top-already')).toBeNull();
  });

  it('says You pay when the leader is subscribed, matched by stored source name with no lookup', async () => {
    mockRows = [row('Handelsblatt', 3)];
    mockSubs = [{ publisherName: 'Handelsblatt Media', sourceNamesJson: '["handelsblatt"]', publisherId: 'hb' }];
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-top-paid')).toBeTruthy());
    expect(screen.queryByTestId('visited-top-already')).toBeNull();
  });
});

describe('VisitedPublicationsList: rows', () => {
  it('shows Support only with a subscribe page, and starts the flow', async () => {
    mockRows = [row('A', 1), row('TechRadar', 1)];
    mockResolved = { TechRadar: withUri('TechRadar') };
    render(<VisitedPublicationsList active />);
    const support = await waitFor(() => screen.getByTestId('visited-support-TechRadar'));
    expect(screen.queryByTestId('visited-support-A')).toBeNull();
    fireEvent.press(support);
    expect(mockBegin).toHaveBeenCalledWith(mockResolved.TechRadar);
  });

  it('marks a subscribed row Subscribed and You pay, with no Support', async () => {
    mockRows = [row('A', 1), row('NRC', 1)];
    mockResolved = { NRC: withUri('NRC', 'nrc') };
    mockSubs = [{ publisherName: 'Other', sourceNamesJson: null, publisherId: 'nrc' }];
    render(<VisitedPublicationsList active />);
    const nrc = await waitFor(() => screen.getByTestId('visited-row-NRC'));
    await waitFor(() => expect(nrc).toHaveTextContent(/library\.visited\.subscribed/));
    expect(nrc).toHaveTextContent(/library\.visited\.youPay/);
    expect(screen.queryByTestId('visited-support-NRC')).toBeNull();
  });

  it('a row shows when it was last opened', async () => {
    mockRows = [row('A', 1), row('B', 1)];
    render(<VisitedPublicationsList active />);
    const a = await waitFor(() => screen.getByTestId('visited-row-A'));
    expect(a).toHaveTextContent(/library\.visited\.lastOpened/);
  });

  it('a tap opens the publication page by name and country; a sideways drag does not', async () => {
    mockRows = [row('A', 1), row('NOS', 1, 'NLD')];
    render(<VisitedPublicationsList active />);
    const open = await waitFor(() => screen.getByTestId('visited-row-open-NOS'));
    fireEvent(open, 'pressIn', { nativeEvent: { pageX: 40, pageY: 300 } });
    fireEvent(open, 'press', { nativeEvent: { pageX: 250, pageY: 304 } });
    expect(mockOpenPage).not.toHaveBeenCalled();
    tap(open);
    expect(mockOpenPage).toHaveBeenCalledWith({ rawName: 'NOS', countryCode: 'NLD' });
  });

  it('mounts one confirm dialog for the page', async () => {
    mockRows = [row('A', 1), row('B', 1)];
    render(<VisitedPublicationsList active />);
    await waitFor(() => expect(screen.getByTestId('visited-row-A')).toBeTruthy());
    expect(screen.getAllByTestId('confirm-dialog')).toHaveLength(1);
  });
});
