// The chip X is a REAL staged delete with a short undo.
//
// The assertion that matters is "still rendered after the row leaves the
// observable": the service drops the row the instant it is staged, so a card
// rendering straight off `observeByFact` would lose the chip on tap and take
// the Undo with it. Everything else here guards against this card growing a
// second copy of the service's own timer.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('react-native-reanimated', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => R.createElement(RN.View, p) },
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.Text, null, p.text) };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ retryTopicGeneration: jest.fn() }));
jest.mock('@/lib/database/services/fact-service', () => ({
  observeTopicsStatus: () => ({
    subscribe: (fn: (v: string) => void) => {
      fn('done');
      return { unsubscribe: jest.fn() };
    },
  }),
}));
jest.mock('@/lib/database/services/topic-planning-service', () => ({
  generateMoreTopicsForFact: jest.fn(),
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatFactMutationVersion: () => 0,
}));

type Row = { id: string; text: string; status: string };
// jest permits an out-of-scope factory reference only when the name starts
// with `mock`. These three are referenced from hoisted mock factories.
let mockEmit: ((rows: Row[]) => void) | null = null;
jest.mock('@/lib/database/services/topic-service', () => ({
  observeByFact: () => ({
    subscribe: (fn: (rows: Row[]) => void) => {
      mockEmit = fn;
      fn([
        { id: 't1', text: 'Amsterdam housing', status: 'active' },
        { id: 't2', text: 'Dutch rents', status: 'active' },
      ]);
      return { unsubscribe: jest.fn() };
    },
  }),
}));

const mockDeleteTopicWithDecline = jest.fn(async () => ({ undoToken: 't1' }));
const mockUndoPendingDelete = jest.fn(async () => true);
jest.mock('@/lib/database/services/topic-decline-service', () => ({
  deleteTopicWithDecline: (...a: unknown[]) => mockDeleteTopicWithDecline(...(a as [])),
  undoPendingDelete: (...a: unknown[]) => mockUndoPendingDelete(...(a as [])),
  UNDO_WINDOW_MS: 5000,
}));

// AccessibilityInfo is SPIED, not module-mocked: replacing the module drops
// the methods the RN jest setup itself calls (isReduceMotionEnabled), which
// fails the suite before any test body runs.
let screenReader = false;

import ChatTopicsCard from '../ChatTopicsCard';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';

const facts = [{ factId: 'f1', factStatement: 'I moved to Nieuw-West' }];

/** The accordion starts collapsed, so the chips are not mounted until the
 *  header is tapped. Opening it is part of reaching the chip, not incidental. */
const openAccordion = (getByTestId: (id: string) => unknown) =>
  act(() => {
    fireEvent.press(getByTestId('chat-topics-header-f1') as never);
  });

/** Stage a delete the way the service does: the row leaves the observable. */
const rowLeavesObservable = () =>
  act(() => {
    mockEmit?.([{ id: 't2', text: 'Dutch rents', status: 'active' }]);
  });

beforeEach(() => {
  jest.clearAllMocks();
  screenReader = false;
  const { AccessibilityInfo } = require('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isScreenReaderEnabled')
    .mockImplementation(() => Promise.resolve(screenReader));
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  mockDeleteTopicWithDecline.mockResolvedValue({ undoToken: 't1' });
  mockUndoPendingDelete.mockResolvedValue(true);
});

describe('chip X stages a delete', () => {
  it('calls the service exactly once, with the default window', async () => {
    const { getByTestId } = render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    expect(mockDeleteTopicWithDecline).toHaveBeenCalledTimes(1);
    expect(mockDeleteTopicWithDecline).toHaveBeenCalledWith('t1', { undoWindowMs: 5000 });
  });

  it('KEEPS the chip, in its undo state, after the row leaves the observable', async () => {
    const { getByTestId, queryByTestId } = render(
      <ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />,
    );
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    rowLeavesObservable();

    // Without `pendingDelete` this is where the chip, and the Undo with it,
    // would vanish and the affordance would be unreachable.
    expect(getByTestId('chat-topic-chip-undo-t1')).toBeTruthy();
    expect(queryByTestId('chat-topic-chip-remove-t1')).toBeNull();
  });

  it('keeps the removed chip IN PLACE, so nothing reflows', async () => {
    const { getByTestId, getAllByText } = render(
      <ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />,
    );
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    rowLeavesObservable();
    // Text is retained, dimmed and struck, at its original index.
    expect(getAllByText('Amsterdam housing')).toHaveLength(1);
  });

  it('asks for a 15s window when a screen reader is on', async () => {
    screenReader = true;
    const { getByTestId } = render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    expect(mockDeleteTopicWithDecline).toHaveBeenCalledWith('t1', { undoWindowMs: 15000 });
  });
});

describe('undo', () => {
  it('calls undoPendingDelete once and stages no second delete', async () => {
    const { getByTestId } = render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    rowLeavesObservable();
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-undo-t1'));
    });
    expect(mockUndoPendingDelete).toHaveBeenCalledTimes(1);
    expect(mockUndoPendingDelete).toHaveBeenCalledWith('t1');
    expect(mockDeleteTopicWithDecline).toHaveBeenCalledTimes(1);
  });

  it('does NOT resurrect the chip when the undo lost the race', async () => {
    // false = the window had already closed. observeByFact is the authority on
    // whether the row came back, so the chip must not reappear from our map.
    mockUndoPendingDelete.mockResolvedValue(false);
    const { getByTestId, queryByTestId } = render(
      <ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />,
    );
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    rowLeavesObservable();
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-undo-t1'));
    });
    expect(queryByTestId('chat-topic-chip-undo-t1')).toBeNull();
    expect(queryByTestId('chat-topic-chip-remove-t1')).toBeNull();
  });
});

describe('the window closing', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('drops the chip and makes NO second service call', async () => {
    const { getByTestId, queryByTestId } = render(
      <ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />,
    );
    openAccordion(getByTestId);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    rowLeavesObservable();
    expect(getByTestId('chat-topic-chip-undo-t1')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(5000 + 50);
    });

    expect(queryByTestId('chat-topic-chip-undo-t1')).toBeNull();
    // The local timer is DISPLAY ONLY. The service owns the commit.
    expect(mockDeleteTopicWithDecline).toHaveBeenCalledTimes(1);
    expect(mockUndoPendingDelete).not.toHaveBeenCalled();
  });
});

describe('Android back', () => {
  it('registers NO BackHandler: back closes the chat and the commit still happens', () => {
    // An earlier design consumed the back event during the undo window, which
    // trapped the user. Staging in the service made that unnecessary.
    const { BackHandler } = require('react-native');
    const spy = jest.spyOn(BackHandler, 'addEventListener');
    render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ux2 batch 26: the chip X is a childless button', () => {
  it('no chip glyph is its own StaticText, before and after a remove', async () => {
    const { getByTestId, UNSAFE_root } = render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);
    openAccordion(getByTestId);
    const glyphs = () => UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
    expect(glyphs().length).toBeGreaterThan(1);
    expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
    await act(async () => {
      fireEvent.press(getByTestId('chat-topic-chip-remove-t1'));
    });
    expect(getByTestId('chat-topic-chip-undo-t1').props.accessibilityLabel).toBe('topicPlan.undo');
    expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
  });
});
