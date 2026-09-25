// The notification centre: a finished fact check opens its article, and a
// cleanup row states the count that is actually waiting.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o && 'count' in o ? `${k}:${o.count}` : k),
  }),
}));
// Renders only the screen's own right action (Clear all), which it passes in.
jest.mock('@/components/custom/config-panel/DrillDownHeader', () => ({ __esModule: true, default: (p: any) => p.rightAction ?? null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/box', () => ({ Box: (p: any) => require('react').createElement(require('react-native').View, p) }));
jest.mock('@/components/ui/hstack', () => ({ HStack: (p: any) => require('react').createElement(require('react-native').View, p) }));
jest.mock('@/components/ui/vstack', () => ({ VStack: (p: any) => require('react').createElement(require('react-native').View, p) }));
jest.mock('@/components/ui/pressable', () => ({ Pressable: (p: any) => require('react').createElement(require('react-native').Pressable, p) }));
jest.mock('@/components/ui/text', () => ({ Text: (p: any) => require('react').createElement(require('react-native').Text, p) }));
// Real icon-font glyphs, so a glyph under an accessible element is caught.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
// The real FlatList pulls in a native ScrollView spec jest cannot parse; a plain
// map renders the same rows.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (p: any) =>
      R.createElement(require('react-native').View, null, ...p.data.map((item: any, index: number) =>
        R.createElement(R.Fragment, { key: p.keyExtractor(item) }, p.renderItem({ item, index })))),
  };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: () => ({ openArticleFeedback: jest.fn(), openOptimisationPlan: jest.fn() }) },
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

let mockRows: any[] = [];
jest.mock('@/lib/database/services/notification-service', () => ({
  observeAll: () => ({ subscribe: (fn: (r: any[]) => void) => { fn(mockRows); return { unsubscribe: jest.fn() }; } }),
  markRead: jest.fn(async () => {}),
  markActioned: jest.fn(async () => {}),
  markAllRead: jest.fn(async () => 0),
  clearAll: jest.fn(async () => 0),
}));
let mockPending = 0;
jest.mock('@/lib/database/services/hygiene-service', () => ({
  getPendingCount: jest.fn(async () => mockPending),
  subscribeHygieneChange: () => () => {},
}));
const mockResolve = jest.fn(async (d: any) => ({ pathname: '/logged-in/article-detail', params: { articleId: d.articleId } }));
jest.mock('@/lib/notification-service', () => ({
  resolveNotificationRoute: (d: unknown) => mockResolve(d),
}));

import NotificationsScreen from '../NotificationsScreen';

const row = (over: Record<string, unknown>) => ({
  id: 'n1',
  type: 'feed_info',
  title: 't',
  body: 'b',
  icon: null,
  contextJson: null,
  actionsJson: null,
  status: 'unread',
  createdAt: new Date(0),
  ...over,
});

beforeEach(() => {
  mockPush.mockClear();
  mockResolve.mockClear();
  mockPending = 0;
});

it('opens the article of a finished fact check, through the shared route resolver', async () => {
  mockRows = [row({
    type: 'fact_check_done',
    title: 'factCheck.notify.title',
    body: 'factCheck.notify.bodyNone',
    contextJson: JSON.stringify({ articleId: 'a1', suggestionId: 's1', title: 'T' }),
    actionsJson: JSON.stringify([{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }]),
  })];
  const { getByText } = render(<NotificationsScreen onBack={jest.fn()} />);
  await act(async () => { fireEvent.press(getByText('factCheck.notify.title')); });
  expect(mockResolve).toHaveBeenCalledWith({ articleId: 'a1', suggestionId: 's1', title: 'T', type: 'fact_check_done' });
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/logged-in/article-detail', params: { articleId: 'a1' } });
});

it('states the cleanups waiting now, not the count stamped when the row was written', async () => {
  mockPending = 2;
  mockRows = [row({
    type: 'hygiene',
    title: 'hygiene.notificationTitle',
    body: 'hygiene.notificationBody',
    contextJson: JSON.stringify({ count: 1 }),
  })];
  const screen = render(<NotificationsScreen onBack={jest.fn()} />);
  await act(async () => {});
  expect(screen.getByText('hygiene.notificationBody:2')).toBeTruthy();
});

// Captured (ux2 batch 27): a row Button read "<glyph>, Fact check ready, ...",
// its icon inside the accessible row. Clear all had its glyph inside too.
it('exposes no private-use StaticText anywhere: row icons and Clear all', async () => {
  mockRows = [row({
    type: 'fact_check_done',
    title: 'factCheck.notify.title',
    body: 'factCheck.notify.bodyNone',
    actionsJson: JSON.stringify([{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }]),
  })];
  const r = render(<NotificationsScreen onBack={jest.fn()} />);
  await act(async () => {});
  const glyphs = r.UNSAFE_root.findAll(
    (n: any) => typeof n.type === 'string' && /[\uE000-\uF8FF]/.test(String(n.props?.children ?? '')),
  );
  // The row icon and the Clear all glyph.
  expect(glyphs.length).toBe(2);
  for (const g of glyphs) {
    expect(g.props.accessible).toBe(false);
    expect(g.props.accessibilityElementsHidden).toBe(true);
    expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
    for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
  }
});

it('keeps Clear all a labelled 44pt button', async () => {
  mockRows = [row({})];
  const { StyleSheet } = require('react-native');
  const r = render(<NotificationsScreen onBack={jest.fn()} />);
  await act(async () => {});
  const clear = r.getByTestId('notifications-clear-all');
  expect(clear.props.accessibilityLabel).toBe('notificationCenter.clearAll');
  const flat = StyleSheet.flatten(clear.props.style);
  expect(flat.width).toBe(44);
  expect(flat.height).toBe(44);
});
