// FeedbackRequestAutoShowHost: shows a live request once, stamping shownAt
// before it navigates, and never over the lock, the startup gate, consent,
// the bug-report modal, the chat or a blocked route.

import React from 'react';
import { act, render } from '@testing-library/react-native';

const mockPush = jest.fn();
let mockPathname = '/logged-in/app_container/feed';
jest.mock('expo-router', () => ({
  router: { push: (...a: unknown[]) => mockPush(...a) },
  usePathname: () => mockPathname,
}));

let mockSession: any = { data: { user: { id: 'u1', termsVersion: '1', privacyVersion: '1' } }, isPending: false };
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => mockSession } }));

let mockVersions: any = { termsVersion: '1', privacyVersion: '1' };
jest.mock('@/components/custom/auth/legal-consent', () => ({
  fetchLegalVersions: jest.fn(async () => mockVersions),
  needsConsent: (u: any, v: any) => !!v && (u?.termsVersion !== v.termsVersion || u?.privacyVersion !== v.privacyVersion),
  wasLegalAcceptedThisProcess: () => false,
}));

let mockGatePassed = true;
jest.mock('@/lib/stores/pending-notification-route', () => ({ isStartupGatePassed: () => mockGatePassed }));

function mockStore<T extends object>(initial: T) {
  const { create } = jest.requireActual('zustand');
  return create(() => initial);
}
jest.mock('@/lib/stores/pin-store', () => ({ usePinStore: mockStore({ locked: false }) }));
jest.mock('@/lib/stores/feedback-store', () => ({ useFeedbackStore: mockStore({ visible: false }) }));
jest.mock('@/lib/stores/floating-chat-store', () => ({ useFloatingChatStore: mockStore({ isExpanded: false }) }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

const ID = '0123456789abcdef01234567';
let mockCandidate: string | null = ID;
const mockShown = jest.fn(async (..._a: unknown[]) => true);
jest.mock('@/lib/feedback-requests/feedback-request-state', () => ({
  readFeedbackRequestsState: jest.fn(async () => ({})),
  pickAutoShowCandidate: () => mockCandidate,
  markFeedbackRequestShown: (...a: unknown[]) => mockShown(...a),
  subscribeFeedbackRequestsState: () => () => {},
}));

import FeedbackRequestAutoShowHost from '../FeedbackRequestAutoShowHost';
import { usePinStore } from '@/lib/stores/pin-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

async function runSettle() {
  await act(async () => {
    jest.advanceTimersByTime(1600);
  });
  // Let the async show chain finish.
  await act(async () => {});
  await act(async () => {});
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPush.mockClear();
  mockShown.mockClear();
  mockPathname = '/logged-in/app_container/feed';
  mockGatePassed = true;
  mockCandidate = ID;
  mockVersions = { termsVersion: '1', privacyVersion: '1' };
  mockSession = { data: { user: { id: 'u1', termsVersion: '1', privacyVersion: '1' } }, isPending: false };
  (usePinStore as any).setState({ locked: false });
  (useFloatingChatStore as any).setState({ isExpanded: false });
});

afterEach(() => {
  jest.useRealTimers();
});

it('stamps shownAt, then opens the modal route', async () => {
  render(<FeedbackRequestAutoShowHost />);
  await runSettle();
  expect(mockShown).toHaveBeenCalledWith(ID);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/logged-in/feedback-request', params: { id: ID } });
  expect(mockShown.mock.invocationCallOrder[0]).toBeLessThan(mockPush.mock.invocationCallOrder[0]);
});

it('nothing to show: no stamp, no navigation', async () => {
  mockCandidate = null;
  render(<FeedbackRequestAutoShowHost />);
  await runSettle();
  expect(mockShown).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
});

it.each([
  ['the onboarding route', () => { mockPathname = '/logged-in/onboarding'; }],
  ['the modal itself', () => { mockPathname = '/logged-in/feedback-request'; }],
  ['the startup gate route', () => { mockPathname = '/logged-in'; }],
  ['the PIN lock', () => { (usePinStore as any).setState({ locked: true }); }],
  ['an open chat', () => { (useFloatingChatStore as any).setState({ isExpanded: true }); }],
  ['a pending session', () => { mockSession = { data: null, isPending: true }; }],
  ['a startup gate not yet passed', () => { mockGatePassed = false; }],
  ['ConsentGate showing', () => { mockVersions = { termsVersion: '2', privacyVersion: '1' }; }],
])('defers on %s', async (_name, arrange) => {
  arrange();
  render(<FeedbackRequestAutoShowHost />);
  await runSettle();
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockShown).not.toHaveBeenCalled();
});

it('retries once the blocker clears', async () => {
  (usePinStore as any).setState({ locked: true });
  render(<FeedbackRequestAutoShowHost />);
  await runSettle();
  expect(mockPush).not.toHaveBeenCalled();
  await act(async () => { (usePinStore as any).setState({ locked: false }); });
  await runSettle();
  expect(mockPush).toHaveBeenCalledTimes(1);
});
