// The one chat announcer: a status is spoken once it has held, a retry at
// once, nothing twice in a row, nothing after the turn released its line.
import { AccessibilityInfo } from 'react-native';
import { ANNOUNCE_HOLD_MS, chatAnnouncer, createAnnouncer } from '@/components/custom/chat/phase-announcer';
import { applyChatPhase, useChatPhaseStore } from '@/lib/llm/chat-phase-store';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('createAnnouncer', () => {
  it('speaks only a status that held for the hold time', () => {
    const speak = jest.fn();
    const a = createAnnouncer(speak);
    a.offer('Preparing');
    jest.advanceTimersByTime(300);
    a.offer('Encrypting');
    jest.advanceTimersByTime(300);
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(speak.mock.calls).toEqual([['Reading']]);
  });

  it('speaks a retry at once', () => {
    const speak = jest.fn();
    const a = createAnnouncer(speak);
    a.offer('Reading');
    a.offer('Trying another route', { urgent: true });
    expect(speak.mock.calls).toEqual([['Trying another route']]);
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('thinking, thinking, retrying, thinking speaks three times, not four', () => {
    const speak = jest.fn();
    const a = createAnnouncer(speak);
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    a.offer('Retrying', { urgent: true });
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(speak.mock.calls).toEqual([['Reading'], ['Retrying'], ['Reading']]);
  });

  it('speaks nothing after stop, and again after start', () => {
    const speak = jest.fn();
    const a = createAnnouncer(speak);
    a.offer('Reading');
    a.stop();
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    a.offer('Working on it', { urgent: true });
    expect(speak).not.toHaveBeenCalled();
    a.start();
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(speak.mock.calls).toEqual([['Reading']]);
  });
});

describe('chatAnnouncer follows the phase store', () => {
  it('stops on release and starts again when the next turn opens', () => {
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const a = chatAnnouncer();
    useChatPhaseStore.getState().reset();
    applyChatPhase('thinking');
    a.offer('Reading');
    applyChatPhase(null); // the answer is on screen
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(spy).not.toHaveBeenCalled();

    useChatPhaseStore.getState().reset(); // next turn
    a.offer('Reading');
    jest.advanceTimersByTime(ANNOUNCE_HOLD_MS);
    expect(spy.mock.calls).toEqual([['Reading']]);
    spy.mockRestore();
  });
});
