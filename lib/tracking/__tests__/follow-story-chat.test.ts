// follow-story-chat unit tests — what the Followed-stories track FAB actually
// does. The assertion that matters is the SEAM: the follow-story chat is opened
// through the existing `openArticleFeedback(context, initialMessage)` store
// action (context + auto-sent opening turn + fresh conversation, one atomic
// set), NOT through a new pending-message channel of its own.

const mockOpenArticleFeedback = jest.fn();
const mockExpand = jest.fn();
const mockHapticLight = jest.fn();

jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: () => ({
      openArticleFeedback: (...args: unknown[]) => mockOpenArticleFeedback(...args),
      expand: (...args: unknown[]) => mockExpand(...args),
    }),
  },
}));

jest.mock('../../haptics', () => ({
  hapticLight: (...args: unknown[]) => mockHapticLight(...args),
}));

import { startFollowStoryChat } from '../follow-story-chat';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('startFollowStoryChat', () => {
  it('opens the chat on the follow-story context, seeded with the follow intent', () => {
    startFollowStoryChat('I want to follow a story.');

    expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
    expect(mockOpenArticleFeedback).toHaveBeenCalledWith(
      { kind: 'follow-story' },
      'I want to follow a story.',
    );
  });

  // The seeded turn is the whole point of using this action rather than
  // `expand()`: without it the thread opens on a silent persona-shaped intro and
  // the user has to work out what to type.
  it('does NOT use the plain expand() path (which seeds nothing)', () => {
    startFollowStoryChat('I want to follow a story.');

    expect(mockExpand).not.toHaveBeenCalled();
  });

  it('carries no article/suggestion identity into the context', () => {
    startFollowStoryChat('seed');

    const [context] = mockOpenArticleFeedback.mock.calls[0];
    expect(Object.keys(context)).toEqual(['kind']);
  });

  it('fires the tap haptic', () => {
    startFollowStoryChat('seed');

    expect(mockHapticLight).toHaveBeenCalledTimes(1);
  });

  it('passes the caller-resolved string through verbatim (no i18n in lib/)', () => {
    startFollowStoryChat('Ich möchte einer Story folgen.');

    expect(mockOpenArticleFeedback).toHaveBeenCalledWith(
      { kind: 'follow-story' },
      'Ich möchte einer Story folgen.',
    );
  });
});
