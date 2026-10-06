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
const mockNavigateToTabScreen = jest.fn();
jest.mock('@/components/custom/nav/navigate-to-page', () => ({
  navigateToTabScreen: (...a: unknown[]) => mockNavigateToTabScreen(...a),
}));

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

let mockFeedbackState: Record<string, any> = {};
jest.mock('@/lib/feedback-requests/feedback-request-state', () => ({
  readFeedbackRequestsState: jest.fn(async () => mockFeedbackState),
  subscribeFeedbackRequestsState: () => () => {},
  isFeedbackRequestEnded: (e: { endsAt: number }) => e.endsAt <= Date.now(),
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
  mockFeedbackState = {};
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
  // The 44pt frame is the button's own parent, pulled back to the 36pt ring by
  // negative margins: a button overflowing its parent can miss taps on Android.
  const frame = StyleSheet.flatten(r.getByTestId('notifications-clear-all-frame').props.style);
  expect(frame).toMatchObject({ width: 44, height: 44, margin: -4 });
  expect(StyleSheet.flatten(clear.props.style)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
});

// The action chips sit inside the accessible row, so VoiceOver could not reach
// them. Each is a custom action on the row, wired to the chip's own handler;
// the chips stay as they are for touch.
describe('row action chips for VoiceOver', () => {
  const hygieneRow = () => row({
    id: 'h1',
    type: 'hygiene',
    title: 'hygiene.notificationTitle',
    body: 'hygiene.notificationBody',
    actionsJson: JSON.stringify([{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }]),
  });

  it('lists each chip as a named action on the row, and labels the row without the chips', async () => {
    mockRows = [hygieneRow()];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    const rowEl = r.getByTestId('notification-row-h1');
    expect(rowEl.props.accessibilityActions).toEqual([{ name: 'chip:review-hygiene', label: 'hygiene.reviewChip' }]);
    expect(rowEl.props.accessibilityLabel.startsWith('hygiene.notificationTitle, hygiene.notificationBody')).toBe(true);
    expect(rowEl.props.accessibilityLabel).not.toContain('hygiene.reviewChip');
  });

  it('runs the chip handler from the row action, same as a tap on the chip', async () => {
    mockRows = [hygieneRow()];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    await act(async () => {
      fireEvent(r.getByTestId('notification-row-h1'), 'accessibilityAction', { nativeEvent: { actionName: 'chip:review-hygiene' } });
    });
    expect(mockNavigateToTabScreen).toHaveBeenCalledWith('you', 'hygiene-review');
    mockNavigateToTabScreen.mockClear();
    await act(async () => { fireEvent.press(r.getByText('hygiene.reviewChip')); });
    expect(mockNavigateToTabScreen).toHaveBeenCalledWith('you', 'hygiene-review');
  });
});

describe('feedback-request rows', () => {
  const ID = '0123456789abcdef01234567';
  const fbRow = (over: Record<string, unknown> = {}) => row({
    type: 'feedback_request',
    title: 'feedbackRequest.title',
    // Free text with i18next separators: must never go through t().
    body: 'Stored: what do you think?',
    contextJson: JSON.stringify({ feedbackRequestId: ID, endsAt: Date.now() + 60_000 }),
    source: `feedback_request:${ID}`,
    ...over,
  });

  // Without its own branch the row has context, so it would open chat.
  it('opens the feedback-request modal, not chat', async () => {
    mockRows = [fbRow()];
    const { getByText } = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => { fireEvent.press(getByText('feedbackRequest.title')); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/logged-in/feedback-request', params: { id: ID } });
  });

  it('a row with a malformed id opens nothing', async () => {
    mockRows = [fbRow({ contextJson: JSON.stringify({ feedbackRequestId: 'nope' }) })];
    const { getByText } = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => { fireEvent.press(getByText('feedbackRequest.title')); });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows the latest question from device state, raw', async () => {
    mockFeedbackState = { [ID]: { question: 'Quelle: votre avis?', endsAt: Date.now() + 60_000 } };
    mockRows = [fbRow()];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    expect(r.getByText('Quelle: votre avis?')).toBeTruthy();
    expect(r.queryByTestId('notification-status-n1')).toBeNull();
  });

  it('falls back to the stored question when the device has no entry', async () => {
    mockRows = [fbRow()];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    expect(r.getByText('Stored: what do you think?')).toBeTruthy();
  });

  it('labels an answered request Answered', async () => {
    mockFeedbackState = { [ID]: { question: 'Q', endsAt: Date.now() + 60_000, answeredAt: 1 } };
    mockRows = [fbRow()];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    expect(r.getByTestId('notification-status-n1').props.children).toBe('feedbackRequest.drawerAnswered');
  });

  it('labels an ended request Closed, from the row context when state is gone', async () => {
    mockRows = [fbRow({ contextJson: JSON.stringify({ feedbackRequestId: ID, endsAt: Date.now() - 1 }) })];
    const r = render(<NotificationsScreen onBack={jest.fn()} />);
    await act(async () => {});
    expect(r.getByTestId('notification-status-n1').props.children).toBe('feedbackRequest.drawerClosed');
  });
});
