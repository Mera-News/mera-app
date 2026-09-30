// FeedbackRequestModal: the states a reader can land in, and what each one
// records on the device. The data layer is mocked; its own suites cover it.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

// jest-expo mis-transforms RN's ScrollView and ActivityIndicator native
// components: proxy both to a View.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const ReactLib = require('react');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'ScrollView') {
        return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
      }
      if (prop === 'ActivityIndicator') {
        return (p: any) => ReactLib.createElement(actual.View, p);
      }
      return target[prop];
    },
  });
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('@/components/custom/GlassSurface', () => ({
  GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
  TranslucentPlate: () => null,
}));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/text', () => ({ Text: (p: any) => require('react').createElement(require('react-native').Text, p) }));
jest.mock('@/components/ui/input', () => ({
  Input: (p: any) => require('react').createElement(require('react-native').View, p),
  InputField: (p: any) => require('react').createElement(require('react-native').TextInput, p),
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));
jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: { getState: () => ({ appLanguage: 'zh-Hans' }) },
}));

let mockSession: any = { data: { user: { id: 'u1' } }, isPending: false };
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => mockSession } }));
let mockLocalUserId: string | null = 'u1';
jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: (sel: (s: { userId: string | null }) => unknown) => sel({ userId: mockLocalUserId }),
}));
let mockConsentBlocks: boolean | Error = false;
jest.mock('../feedback-request-consent', () => ({
  consentBlocksFeedbackRequest: jest.fn(async () => {
    if (mockConsentBlocks instanceof Error) throw mockConsentBlocks;
    return mockConsentBlocks;
  }),
}));

const mockMarkActionedBySource = jest.fn(async (_s: string) => 1);
jest.mock('@/lib/database/services/notification-service', () => ({
  markActionedBySource: (s: string) => mockMarkActionedBySource(s),
}));
const mockFetch = jest.fn();
const mockSubmit = jest.fn();
jest.mock('@/lib/feedback-requests/feedback-request-service', () => ({
  FEEDBACK_RESPONSE_MAX_CHARS: 2000,
  fetchActiveFeedbackRequests: (...a: unknown[]) => mockFetch(...a),
  submitFeedbackResponse: (...a: unknown[]) => mockSubmit(...a),
}));
let mockState: Record<string, any> = {};
const mockShown = jest.fn(async (..._a: unknown[]) => true);
const mockDismissed = jest.fn(async (..._a: unknown[]) => {});
const mockAnswered = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/feedback-requests/feedback-request-state', () => ({
  readFeedbackRequestsState: jest.fn(async () => mockState),
  isFeedbackRequestEnded: (e: { endsAt: number }) => e.endsAt <= Date.now(),
  markFeedbackRequestShown: (...a: unknown[]) => mockShown(...a),
  markFeedbackRequestDismissed: (...a: unknown[]) => mockDismissed(...a),
  markFeedbackRequestAnswered: (...a: unknown[]) => mockAnswered(...a),
}));
const mockIngest = jest.fn(async (..._a: unknown[]) => ({ newRows: 1, answered: 0 }));
jest.mock('@/lib/feedback-requests/feedback-request-sync', () => ({
  feedbackRequestNotificationSource: (id: string) => `feedback_request:${id}`,
  ingestFeedbackRequests: (...a: unknown[]) => mockIngest(...a),
}));

import FeedbackRequestModal from '../FeedbackRequestModal';

const ID = '0123456789abcdef01234567';
const LIVE = () => ({ question: 'What should we build next?', endsAt: Date.now() + 60_000 });

async function mount(id: string | undefined = ID) {
  const onClose = jest.fn();
  const r = render(<FeedbackRequestModal id={id} onClose={onClose} />);
  await act(async () => {});
  return { ...r, onClose };
}

beforeEach(() => {
  mockState = {};
  mockSession = { data: { user: { id: 'u1' } }, isPending: false };
  mockLocalUserId = 'u1';
  mockConsentBlocks = false;
  jest.clearAllMocks();
});

it('open: question, text area, disclaimer, submit disabled until there is text', async () => {
  mockState = { [ID]: LIVE() };
  const r = await mount();
  expect(r.getByTestId('feedback-request-question').props.children).toBe('What should we build next?');
  expect(r.getByTestId('feedback-request-disclaimer').props.children).toBe('feedbackRequest.disclaimer');
  const submit = r.getByTestId('feedback-request-submit');
  expect(submit.props.accessibilityLabel).toBe('feedbackRequest.submit');
  expect(submit.props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(r.getByTestId('feedback-request-input'), '   ');
  expect(r.getByTestId('feedback-request-submit').props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'Offline reading');
  expect(r.getByTestId('feedback-request-submit').props.accessibilityState.disabled).toBe(false);
  expect(mockShown).toHaveBeenCalledWith(ID, expect.any(Number), expect.objectContaining({ question: 'What should we build next?' }));
});

it('submit ok: thanks, answered stamped, drawer row actioned, disclaimer gone, not a skip', async () => {
  mockState = { [ID]: LIVE() };
  mockSubmit.mockResolvedValue({ status: 'ok', alreadyAnswered: false });
  const r = await mount();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'More sources');
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-submit')); });
  expect(mockSubmit).toHaveBeenCalledWith(ID, 'More sources');
  expect(r.getByTestId('feedback-request-thanks')).toBeTruthy();
  expect(r.queryByTestId('feedback-request-disclaimer')).toBeNull();
  expect(r.queryByTestId('feedback-request-input')).toBeNull();
  expect(mockAnswered).toHaveBeenCalledWith(ID);
  expect(mockMarkActionedBySource).toHaveBeenCalledWith(`feedback_request:${ID}`);
  r.unmount();
  expect(mockDismissed).not.toHaveBeenCalled();
});

it('submit says already answered: that state, as a success', async () => {
  mockState = { [ID]: LIVE() };
  mockSubmit.mockResolvedValue({ status: 'ok', alreadyAnswered: true });
  const r = await mount();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'x');
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-submit')); });
  expect(r.getByTestId('feedback-request-already')).toBeTruthy();
  expect(mockAnswered).toHaveBeenCalledWith(ID);
});

it('submit closed by the server: closed state, text area and disclaimer hidden', async () => {
  mockState = { [ID]: LIVE() };
  mockSubmit.mockResolvedValue({ status: 'closed' });
  const r = await mount();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'x');
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-submit')); });
  expect(r.getByTestId('feedback-request-closed').props.children).toBe('feedbackRequest.closed');
  expect(r.queryByTestId('feedback-request-input')).toBeNull();
  expect(r.queryByTestId('feedback-request-disclaimer')).toBeNull();
});

it('submit error keeps the text for a retry; offline says so', async () => {
  mockState = { [ID]: LIVE() };
  mockSubmit.mockResolvedValueOnce({ status: 'error', offline: true });
  const r = await mount();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'keep me');
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-submit')); });
  expect(r.getByTestId('feedback-request-error').props.children).toBe('feedbackRequest.offline');
  expect(r.getByTestId('feedback-request-input').props.value).toBe('keep me');
  expect(r.getByTestId('feedback-request-disclaimer')).toBeTruthy();
  mockSubmit.mockResolvedValueOnce({ status: 'ok', alreadyAnswered: false });
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-submit')); });
  expect(r.getByTestId('feedback-request-thanks')).toBeTruthy();
});

it('ended locally: closed without a network call', async () => {
  mockState = { [ID]: { question: 'Q', endsAt: Date.now() - 1 } };
  const r = await mount();
  expect(r.getByTestId('feedback-request-closed')).toBeTruthy();
  expect(r.getByTestId('feedback-request-question')).toBeTruthy();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('answered on this device earlier: already answered', async () => {
  mockState = { [ID]: { ...LIVE(), answeredAt: 1 } };
  const r = await mount();
  expect(r.getByTestId('feedback-request-already')).toBeTruthy();
});

it('unknown locally (push before the first sync): fetches once in the app language and ingests', async () => {
  mockFetch.mockResolvedValue({ ok: true, requests: [{ id: ID, ...LIVE(), answered: false }] });
  const r = await mount();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith('zh-Hans');
  expect(mockIngest).toHaveBeenCalled();
  expect(r.getByTestId('feedback-request-input')).toBeTruthy();
});

it('unknown locally and absent from the active list: closed', async () => {
  mockFetch.mockResolvedValue({ ok: true, requests: [] });
  const r = await mount();
  expect(r.getByTestId('feedback-request-closed')).toBeTruthy();
  r.unmount();
  expect(mockDismissed).not.toHaveBeenCalled();
});

it('unknown locally and the fetch fails: load error with retry', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, offline: false });
  const r = await mount();
  expect(r.getByTestId('feedback-request-load-error').props.children).toBe('feedbackRequest.loadError');
  mockFetch.mockResolvedValueOnce({ ok: true, requests: [{ id: ID, ...LIVE(), answered: false }] });
  await act(async () => { fireEvent.press(r.getByTestId('feedback-request-retry')); });
  expect(r.getByTestId('feedback-request-input')).toBeTruthy();
});

it('a malformed id is closed and fetches nothing', async () => {
  const r = await mount('not-an-id');
  expect(r.getByTestId('feedback-request-closed')).toBeTruthy();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('closing unanswered is a skip: dismissedAt stamped', async () => {
  mockState = { [ID]: LIVE() };
  const r = await mount();
  fireEvent.press(r.getByTestId('feedback-request-close'));
  expect(r.onClose).toHaveBeenCalled();
  r.unmount();
  expect(mockDismissed).toHaveBeenCalledWith(ID);
});

it('shows a counter only near the limit', async () => {
  mockState = { [ID]: LIVE() };
  const r = await mount();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'a'.repeat(1799));
  expect(r.queryByTestId('feedback-request-counter')).toBeNull();
  fireEvent.changeText(r.getByTestId('feedback-request-input'), 'a'.repeat(1800));
  expect(r.getByTestId('feedback-request-counter')).toBeTruthy();
});

describe('consent guard (every entry point)', () => {
  it('consent not accepted: no card, closes itself, stamps nothing', async () => {
    mockState = { [ID]: LIVE() };
    mockConsentBlocks = true;
    const r = await mount();
    expect(r.queryByTestId('feedback-request-card')).toBeNull();
    expect(r.onClose).toHaveBeenCalledTimes(1);
    r.unmount();
    expect(mockShown).not.toHaveBeenCalled();
    expect(mockDismissed).not.toHaveBeenCalled();
  });

  it('while the session is unresolved: no card, no close yet', async () => {
    mockState = { [ID]: LIVE() };
    mockSession = { data: null, isPending: true };
    const r = await mount();
    expect(r.queryByTestId('feedback-request-card')).toBeNull();
    expect(r.getByTestId('feedback-request-consent-wait')).toBeTruthy();
    expect(r.onClose).not.toHaveBeenCalled();
    expect(mockShown).not.toHaveBeenCalled();
  });

  it('no signed-in account at all: closes without a card', async () => {
    mockSession = { data: null, isPending: false };
    mockLocalUserId = null;
    const r = await mount();
    expect(r.queryByTestId('feedback-request-card')).toBeNull();
    expect(r.onClose).toHaveBeenCalled();
  });

  it('offline (no session, local account): the check decides, the card shows', async () => {
    mockState = { [ID]: LIVE() };
    mockSession = { data: null, isPending: false };
    const r = await mount();
    expect(r.getByTestId('feedback-request-card')).toBeTruthy();
  });

  it('a failing check fails open, like ConsentGate', async () => {
    mockState = { [ID]: LIVE() };
    mockConsentBlocks = new Error('boom');
    const r = await mount();
    expect(r.getByTestId('feedback-request-card')).toBeTruthy();
  });
});
