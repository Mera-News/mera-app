// The topics accordion: collapsed by default, status observed live, and a
// "Try again" that appears WITHOUT the card pretending generation has failed.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

// `close` is echoed so the saved line's glyph vs spoken word can be told apart.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { close?: string }) => (o?.close ? `${k}|close=${o.close}` : k) }),
}));
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

const mockRetry = jest.fn();
jest.mock('@/lib/chat-tools/tool-handlers', () => ({
  retryTopicGeneration: (...a: unknown[]) => mockRetry(...(a as [])),
}));
const mockGenerateMore = jest.fn(async () => ({ mode: 'inline' }));
jest.mock('@/lib/database/services/topic-planning-service', () => ({
  generateMoreTopicsForFact: (...a: unknown[]) => mockGenerateMore(...(a as [])),
}));
jest.mock('@/lib/database/services/topic-decline-service', () => ({
  deleteTopicWithDecline: jest.fn(),
  undoPendingDelete: jest.fn(),
  UNDO_WINDOW_MS: 5000,
}));

let mockStatus = 'pending';
let mockRows: unknown[] = [{ id: 't1', text: 'Amsterdam housing', status: 'active' }];
let mockEmitStatus: ((v: string) => void) | null = null;
jest.mock('@/lib/database/services/fact-service', () => ({
  observeTopicsStatus: () => ({
    subscribe: (fn: (v: string) => void) => {
      mockEmitStatus = fn;
      fn(mockStatus);
      return { unsubscribe: jest.fn() };
    },
  }),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  observeByFact: () => ({
    subscribe: (fn: (rows: unknown[]) => void) => {
      fn(mockRows);
      return { unsubscribe: jest.fn() };
    },
  }),
}));

import ChatTopicsCard, { OFFER_RETRY_AFTER_MS } from '../ChatTopicsCard';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';

const facts = [{ factId: 'f1', factStatement: 'I moved to Nieuw-West' }];
const draw = () => render(<ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" />);

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus = 'pending';
});

describe('collapsed by default', () => {
  it('shows the header and hides the chips until it is opened', () => {
    mockStatus = 'done';
    const { getByTestId, queryByTestId } = draw();
    expect(getByTestId('chat-topics-header-f1')).toBeTruthy();
    expect(queryByTestId('chat-topic-chip-remove-t1')).toBeNull();

    act(() => {
      fireEvent.press(getByTestId('chat-topics-header-f1'));
    });
    expect(getByTestId('chat-topic-chip-remove-t1')).toBeTruthy();
  });

  it('reports its expanded state to assistive tech', () => {
    mockStatus = 'done';
    const { getByTestId } = draw();
    expect(getByTestId('chat-topics-header-f1').props.accessibilityState.expanded).toBe(false);
    act(() => {
      fireEvent.press(getByTestId('chat-topics-header-f1'));
    });
    expect(getByTestId('chat-topics-header-f1').props.accessibilityState.expanded).toBe(true);
  });
});

describe('the COLLAPSED card while generating', () => {
  it('shows a small spinner, and no progress words', () => {
    // Without it the rows ran one at a time with nothing moving and the card
    // read as finished (audit F13).
    const { getByText, getByTestId, queryByTestId } = draw();
    expect(getByText('chatTopics.accordionTitlePending', { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId('chat-topics-spinner-f1', { includeHiddenElements: true })).toBeTruthy();
    expect(queryByTestId('chat-topics-progress')).toBeNull();
    expect(queryByTestId('chat-topics-retry-slow')).toBeNull();
  });

  it('opens itself when the topics it was waiting for arrive', () => {
    const { getByTestId, queryByTestId } = draw();
    expect(queryByTestId('chat-topic-chip-remove-t1')).toBeNull();
    act(() => { mockEmitStatus?.('done'); });
    expect(getByTestId('chat-topics-header-f1').props.accessibilityState.expanded).toBe(true);
    expect(queryByTestId('chat-topics-spinner-f1', { includeHiddenElements: true })).toBeNull();
  });

  it('stays closed when the user closed it themselves', () => {
    const { getByTestId } = draw();
    act(() => { fireEvent.press(getByTestId('chat-topics-header-f1')); });
    act(() => { fireEvent.press(getByTestId('chat-topics-header-f1')); });
    act(() => { mockEmitStatus?.('done'); });
    expect(getByTestId('chat-topics-header-f1').props.accessibilityState.expanded).toBe(false);
  });

  it('still tells assistive tech the state, since nothing on screen does', () => {
    const { getByTestId } = draw();
    expect(getByTestId('chat-topics-header-f1').props.accessibilityLabel).toContain(
      'chatTopics.pendingA11y',
    );
  });

  it('switches to the plain title and a SMALL, MUTED tick when done', () => {
    mockStatus = 'done';
    const { getByText, getByTestId } = draw();
    expect(getByText('chatTopics.accordionTitle', { includeHiddenElements: true })).toBeTruthy();
    // Asserted on the glyph and its size/colour rather than a testID: a
    // finished background job should be confirmable at a glance, not
    // announce itself, and "small and muted" is the requirement.
    const tick = getByTestId('chat-topics-done-f1', { includeHiddenElements: true });
    expect(tick.props.name).toBe('check');
    expect(tick.props.size).toBe(14);
    expect(tick.props.color).toBe('rgb(150, 150, 150)');
    expect(getByTestId('chat-topics-header-f1').props.accessibilityLabel).toContain(
      'chatTopics.readyA11y',
    );
  });

  it('keeps the ERROR state visible while collapsed, because the user must act', () => {
    mockStatus = 'error';
    const { getByTestId, getByText } = draw();
    expect(getByTestId('chat-topics-retry')).toBeTruthy();
    expect(getByText('floatingChat.topicGenFailed', { includeHiddenElements: true })).toBeTruthy();
    expect(getByTestId('chat-topics-header-f1').props.accessibilityLabel).toContain(
      'chatTopics.failedA11y',
    );
  });

  it('renders a one-line tombstone when the fact is gone, never a blank card', () => {
    mockStatus = 'gone';
    const { getByTestId, queryByTestId } = draw();
    expect(getByTestId('chat-topics-gone')).toBeTruthy();
    expect(queryByTestId('chat-topics-card')).toBeNull();
  });
});

const open = (getByTestId: (id: string) => unknown) =>
  act(() => {
    fireEvent.press(getByTestId('chat-topics-header-f1') as never);
  });

describe('the EXPANDED card is where progress lives', () => {
  it('shows the spinner and the progress words once opened', () => {
    const { getByTestId, getByText } = draw();
    open(getByTestId);
    expect(getByTestId('chat-topics-progress')).toBeTruthy();
    expect(getByTestId('chat-topics-status-f1-spinner')).toBeTruthy();
    expect(getByText('chatTopics.finding')).toBeTruthy();
  });

  it('shows no progress row once the status has settled', () => {
    mockStatus = 'done';
    const { getByTestId, queryByTestId } = draw();
    open(getByTestId);
    expect(queryByTestId('chat-topics-progress')).toBeNull();
  });
});

describe('the 75s Try again is an EXPANDED-only escape hatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('never reaches the collapsed card, however long it waits', () => {
    // Surfacing it collapsed would turn a quiet "we're on it" into a demand
    // for attention, which is exactly what this layout avoids.
    const { queryByTestId } = draw();
    act(() => {
      jest.advanceTimersByTime(OFFER_RETRY_AFTER_MS * 2);
    });
    expect(queryByTestId('chat-topics-retry-slow')).toBeNull();
    expect(queryByTestId('chat-topics-retry')).toBeNull();
  });

  it('appears inside the open card WITHOUT the card becoming an error', () => {
    const { getByTestId, queryByTestId } = draw();
    open(getByTestId);
    expect(queryByTestId('chat-topics-retry-slow')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(OFFER_RETRY_AFTER_MS + 100);
    });

    expect(getByTestId('chat-topics-retry-slow')).toBeTruthy();
    // Still PENDING: the spinner keeps going and no failure line appears.
    // This is what separates it from the old timeout, which decided state.
    expect(getByTestId('chat-topics-status-f1-spinner')).toBeTruthy();
    expect(queryByTestId('chat-topics-gone')).toBeNull();
  });

  it('never appears once the status has settled', () => {
    mockStatus = 'done';
    const { getByTestId, queryByTestId } = draw();
    open(getByTestId);
    act(() => {
      jest.advanceTimersByTime(OFFER_RETRY_AFTER_MS * 3);
    });
    expect(queryByTestId('chat-topics-retry-slow')).toBeNull();
  });
});

describe('Find more topics', () => {
  it('has only idle and busy, and is never disabled for a topic count', async () => {
    mockStatus = 'done';
    let resolve!: () => void;
    mockGenerateMore.mockImplementation(
      () => new Promise((r) => { resolve = () => r({ mode: 'inline' }); }),
    );

    const { getByTestId } = draw();
    act(() => {
      fireEvent.press(getByTestId('chat-topics-header-f1'));
    });

    const button = getByTestId('chat-topics-more-f1');
    expect(button.props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      fireEvent.press(button);
    });
    expect(getByTestId('chat-topics-more-f1').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      resolve();
    });
    expect(getByTestId('chat-topics-more-f1').props.accessibilityState.disabled).toBe(false);
    expect(mockGenerateMore).toHaveBeenCalledWith('f1', 'I moved to Nieuw-West', {});
  });
});

describe('ux2 M1: the fact sits on the title line', () => {
  it('renders the fact inside the header row, beside "Topics for:"', () => {
    mockStatus = 'done';
    const { getByTestId } = draw();
    const { within } = require('@testing-library/react-native');
    const row = getByTestId('chat-topics-title-row-f1', { includeHiddenElements: true });
    expect(within(row).getByText('chatTopics.accordionTitle', { includeHiddenElements: true })).toBeTruthy();
    expect(within(row).getByText('I moved to Nieuw-West', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('ux2 F1: the chat turn\'s guideline follows the fact into a retry', () => {
  it('passes the topic skill to Try again', async () => {
    mockStatus = 'error';
    const { getByTestId } = render(
      <ChatTopicsCard factId="f1" factStatement="I moved to Nieuw-West" topicSkillId="topics/residence" />,
    );
    await act(async () => { fireEvent.press(getByTestId('chat-topics-retry')); });
    expect(mockRetry).toHaveBeenCalledWith('f1', 'I moved to Nieuw-West', 'topics/residence');
  });
});

describe('ux2 batch 26: no glyph is its own StaticText, and Retry is reachable', () => {
  const glyphCount = (root: any) =>
    root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children))).length;

  it.each(['pending', 'done', 'error'])('the %s card, collapsed and expanded', (status) => {
    mockStatus = status;
    const { UNSAFE_root, getByTestId } = draw();
    expect(glyphCount(UNSAFE_root)).toBeGreaterThan(0);
    expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
    act(() => { fireEvent.press(getByTestId('chat-topics-header-f1')); });
    expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
  });

  it('Retry is its own element, not nested in the header toggle', () => {
    mockStatus = 'error';
    const { getByTestId } = draw();
    const retry = getByTestId('chat-topics-retry');
    const header = getByTestId('chat-topics-header-f1');
    for (let p: any = retry.parent; p; p = p.parent) expect(p).not.toBe(header);
    expect(header.findAll((n: any) => typeof n.type === 'string' && n !== header)).toHaveLength(0);
  });
});

describe('ux2 P9 owner request: the done card says the topics are saved, and Find more is quiet', () => {
  const open = (r: ReturnType<typeof draw>) => act(() => { fireEvent.press(r.getByTestId('chat-topics-header-f1')); });
  const expandedIfClosed = (r: ReturnType<typeof draw>) => {
    if (!r.getByTestId('chat-topics-header-f1').props.accessibilityState?.expanded) open(r);
  };
  afterEach(() => { mockRows = [{ id: 't1', text: 'Amsterdam housing', status: 'active' }]; });

  it('done with a topic: the saved line shows the close glyph and reads "Close"', () => {
    mockStatus = 'done';
    const r = draw();
    expandedIfClosed(r);
    const line = r.getByTestId('chat-topics-saved-f1');
    expect(line.props.children).toBe('floatingChat.topicsSavedHint|close=\u2715');
    expect(line.props.accessibilityLabel).toBe('floatingChat.topicsSavedHint|close=floatingChat.close');
  });

  it.each(['pending', 'error'])('no saved line while %s', (status) => {
    mockStatus = status;
    const r = draw();
    expandedIfClosed(r);
    expect(r.queryByTestId('chat-topics-saved-f1', { includeHiddenElements: true })).toBeNull();
  });

  it('no saved line when the job finished with no topic', () => {
    mockStatus = 'done';
    mockRows = [];
    const r = draw();
    expandedIfClosed(r);
    expect(r.queryByTestId('chat-topics-saved-f1', { includeHiddenElements: true })).toBeNull();
  });

  it('no saved line on the tombstone', () => {
    mockStatus = 'gone';
    const r = draw();
    expect(r.getByTestId('chat-topics-gone')).toBeTruthy();
    expect(r.queryByTestId('chat-topics-saved-f1', { includeHiddenElements: true })).toBeNull();
  });

  it('Find more is a quiet outlined button: thin neutral outline, no fill, no accent, a numeric 44pt frame, label = visible text, after the line', () => {
    mockStatus = 'done';
    const r = draw();
    expandedIfClosed(r);
    const { StyleSheet } = require('react-native');
    const more = r.getByTestId('chat-topics-more-f1');
    const frame = StyleSheet.flatten(more.props.style) ?? {};
    expect(frame.minHeight).toBe(44);
    expect(frame.borderWidth ?? 0).toBe(0);
    const pill = StyleSheet.flatten(r.getByTestId('chat-topics-more-pill-f1').props.style) ?? {};
    expect(pill.borderWidth).toBe(1);
    expect(pill.borderColor).toBe('rgb(150, 150, 150)');
    expect(pill.backgroundColor).toBeUndefined();
    const text = r.getByText('chatTopics.findMore');
    const textStyle = StyleSheet.flatten(text.props.style) ?? {};
    expect(textStyle.color).toBe('rgb(150, 150, 150)');
    expect(textStyle.textDecorationLine).toBeUndefined();
    expect(text.props.bold).toBeFalsy();
    expect(JSON.stringify([pill, textStyle])).not.toMatch(/231,\s*138,\s*83/);
    expect(more.props.accessibilityLabel).toBe('chatTopics.findMore');
    // Reading order: the saved line, then the optional Find more.
    const order = JSON.stringify(r.toJSON()).match(/chat-topics-(saved|more)-f1/g);
    expect(order).toEqual(['chat-topics-saved-f1', 'chat-topics-more-f1']);
    expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
  });
});
