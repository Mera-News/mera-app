// The topics accordion: collapsed by default, status observed live, and a
// "Try again" that appears WITHOUT the card pretending generation has failed.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return { MaterialIcons: (p: any) => R.createElement(RN.View, { ...p, testID: `icon-${p.name}` }) };
});
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
jest.mock('@/lib/database/services/fact-service', () => ({
  observeTopicsStatus: () => ({
    subscribe: (fn: (v: string) => void) => {
      fn(mockStatus);
      return { unsubscribe: jest.fn() };
    },
  }),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  observeByFact: () => ({
    subscribe: (fn: (rows: unknown[]) => void) => {
      fn([{ id: 't1', text: 'Amsterdam housing', status: 'active' }]);
      return { unsubscribe: jest.fn() };
    },
  }),
}));

import ChatTopicsCard, { OFFER_RETRY_AFTER_MS } from '../ChatTopicsCard';

const facts = [{ factId: 'f1', factStatement: 'I moved to Nieuw-West' }];
const draw = () => render(<ChatTopicsCard facts={facts} merged={false} />);

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

describe('status drives the header', () => {
  it('spins while pending', () => {
    const { getByTestId } = draw();
    expect(getByTestId('chat-topics-status-f1-spinner')).toBeTruthy();
  });

  it('ticks when done', () => {
    mockStatus = 'done';
    const { queryByTestId } = draw();
    expect(queryByTestId('chat-topics-status-f1-spinner')).toBeNull();
  });

  it('offers Try again on error, and states the failure while COLLAPSED', () => {
    mockStatus = 'error';
    const { getByTestId, getByText } = draw();
    expect(getByTestId('chat-topics-retry')).toBeTruthy();
    // A failure you must open a drawer to discover is one nobody sees.
    expect(getByText('floatingChat.topicGenFailed')).toBeTruthy();
  });

  it('renders a one-line tombstone when the fact is gone, never a blank card', () => {
    mockStatus = 'gone';
    const { getByTestId, queryByTestId } = draw();
    expect(getByTestId('chat-topics-gone')).toBeTruthy();
    expect(queryByTestId('chat-topics-card')).toBeNull();
  });
});

describe('the Try again escape hatch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('appears after the wait WITHOUT the card becoming an error', () => {
    const { getByTestId, queryByTestId } = draw();
    expect(queryByTestId('chat-topics-retry')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(OFFER_RETRY_AFTER_MS + 100);
    });

    expect(getByTestId('chat-topics-retry')).toBeTruthy();
    // Still PENDING: the spinner keeps going and no failure line appears. This
    // is what separates it from the old timeout, which decided the state.
    expect(getByTestId('chat-topics-status-f1-spinner')).toBeTruthy();
    expect(queryByTestId('chat-topics-gone')).toBeNull();
  });

  it('never appears once the status has settled', () => {
    mockStatus = 'done';
    const { queryByTestId } = draw();
    act(() => {
      jest.advanceTimersByTime(OFFER_RETRY_AFTER_MS * 3);
    });
    expect(queryByTestId('chat-topics-retry')).toBeNull();
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
    expect(mockGenerateMore).toHaveBeenCalledWith('f1', 'I moved to Nieuw-West');
  });
});
