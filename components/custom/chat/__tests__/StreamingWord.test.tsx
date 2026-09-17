/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k.replace('streamingWords.', '') }),
}));

const mockAnimationsActive = jest.fn(() => true);
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => mockAnimationsActive(),
}));

import StreamingWord from '../StreamingWord';
import { STREAMING_WORD_INTERVAL_MS } from '../streaming-words';

const word = (r: { getByTestId: (id: string) => any }) =>
  r.getByTestId('streaming-word').props.children;

beforeEach(() => {
  jest.clearAllMocks();
  mockAnimationsActive.mockReturnValue(true);
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('rotation', () => {
  it('opens on the first pool word with an ellipsis', () => {
    const r = render(<StreamingWord />);
    expect(word(r)).toBe('w1…');
  });

  it('changes word every interval, never repeating back to back', () => {
    const r = render(<StreamingWord />);
    const seen: string[] = [word(r)];
    for (let i = 0; i < 12; i++) {
      act(() => {
        jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS);
      });
      seen.push(word(r));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).not.toBe(seen[i - 1]);
    }
    // It really rotated rather than sitting on the opener.
    expect(new Set(seen).size).toBeGreaterThan(3);
  });

  it('does not change before the interval elapses', () => {
    const r = render(<StreamingWord />);
    act(() => {
      jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS - 50);
    });
    expect(word(r)).toBe('w1…');
  });
});

describe('when the first delta arrives', () => {
  it('stops rotating, because the component unmounts with the wait', () => {
    // The thread swaps the typing item for the real bubble on first content,
    // so "stop rotating" IS unmount. The assertion that matters is that the
    // interval is cleared and cannot tick against a dead component.
    const r = render(<StreamingWord />);
    act(() => {
      jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS);
    });
    r.unmount();
    expect(() =>
      act(() => {
        jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS * 5);
      }),
    ).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('reduced motion', () => {
  it('shows the opener and never rotates', () => {
    mockAnimationsActive.mockReturnValue(false);
    const r = render(<StreamingWord />);
    expect(word(r)).toBe('w1…');
    act(() => {
      jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS * 10);
    });
    expect(word(r)).toBe('w1…');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('the reasoning wait', () => {
  it('pins a fixed label and does not rotate', () => {
    const r = render(<StreamingWord fixedLabel="Thinking" />);
    expect(word(r)).toBe('Thinking…');
    act(() => {
      jest.advanceTimersByTime(STREAMING_WORD_INTERVAL_MS * 4);
    });
    expect(word(r)).toBe('Thinking…');
  });
});

describe('accessibility', () => {
  it('is ONE polite live region carrying the current word', () => {
    const r = render(<StreamingWord />);
    const node = r.getByTestId('streaming-word');
    expect(node.props.accessibilityLiveRegion).toBe('polite');
    expect(node.props.accessibilityLabel).toBe('w1…');
  });
});
