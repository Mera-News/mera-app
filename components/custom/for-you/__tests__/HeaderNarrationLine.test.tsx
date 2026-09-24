// The header narration line's surface.
//
// `jest.setup.js` does NOT mock react-native-reanimated: importing it throws
// on the uninitialised worklets native module. This file carries its own,
// modelled on `chat/__tests__/ChatPhaseLine.test.tsx`, INCLUDING the
// per-instance shared value — a mock that forgot the value between renders
// would make every crossfade assertion below vacuous.
/* eslint-disable @typescript-eslint/no-require-imports */

let mockReduceMotion = false;

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => mockReduceMotion,
    useSharedValue: (initial: number) => {
      const { useRef } = require('react');
      return useRef({ value: initial }).current;
    },
    withTiming: (v: unknown) => v,
  };
});

// The REAL dictionary through the translator, not a stub that echoes the key.
// A stub would return the dot-path, `returnObjects` would hand back a string,
// the component would wrap it as a one-line pool, and every rotation assertion
// here would pass against a pool that cannot rotate.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { returnObjects?: boolean }) => {
      const en = require('@/lib/locales/en.json');
      const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
      if (opts?.returnObjects) return v ?? [];
      return typeof v === 'string' ? v : key;
    },
  }),
}));

jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});

import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import {
  HEADER_NARRATION_METRICS,
  NARRATION_CYCLE_MS,
  NARRATION_FADE_MS,
} from '../header-narration';
import HeaderNarrationLine, { REDUCED_MOTION_CYCLE_MS } from '../HeaderNarrationLine';

const EN = jest.requireActual('../../../../lib/locales/en.json') as {
  headerNarration: {
    stages: Record<string, string[]>;
    nudges: string[];
    a11y: string;
  };
};

/** The seed is `Math.random() * 6`; pin it so the nudge pool is deterministic. */
function seedNudgeAt(index: number) {
  jest.spyOn(Math, 'random').mockReturnValue(index / 6);
}

function textOf(): string {
  return screen.getByTestId('header-narration-line').props.children as string;
}

/** Advance exactly one full slot, fade included. */
function advanceOneSlot(cycle = NARRATION_CYCLE_MS) {
  act(() => {
    jest.advanceTimersByTime(cycle);
  });
  act(() => {
    jest.advanceTimersByTime(NARRATION_FADE_MS);
  });
}

function renderLine(stage: ProcessingStageId | null, onDevice = false) {
  return render(<HeaderNarrationLine stage={stage} onDevice={onDevice} />);
}

describe('HeaderNarrationLine', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    seedNudgeAt(0);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('centres its text when asked (the Feed slot), and does not by default', () => {
    const { StyleSheet } = require('react-native');
    const view = render(<HeaderNarrationLine stage="fetching" onDevice={false} align="center" />);
    expect(StyleSheet.flatten(screen.getByTestId('header-narration-line').props.style).textAlign).toBe('center');
    view.unmount();
    renderLine('fetching');
    expect(StyleSheet.flatten(screen.getByTestId('header-narration-line').props.style).textAlign).toBeUndefined();
  });

  it('opens on a STAGE line, so the first thing in the title slot says why', () => {
    renderLine('fetching');
    expect(textOf()).toBe(EN.headerNarration.stages.fetching[0]);
  });

  it('shows the `starting` pool before a stage resolves, never a blank row', () => {
    // The row is height-pinned, so nothing here is an empty box, not an absence.
    renderLine(null);
    expect(textOf()).toBe(EN.headerNarration.stages.starting[0]);
  });

  it('alternates stage line, nudge, stage line as it rotates', () => {
    renderLine('fetching');
    expect(textOf()).toBe(EN.headerNarration.stages.fetching[0]);
    advanceOneSlot();
    expect(textOf()).toBe(EN.headerNarration.nudges[0]);
    advanceOneSlot();
    expect(textOf()).toBe(EN.headerNarration.stages.fetching[1]);
    advanceOneSlot();
    expect(textOf()).toBe(EN.headerNarration.nudges[1]);
  });

  it('wraps the cursor on each pool rather than running off the end', () => {
    // The resolver returns an UNBOUNDED cursor on purpose; the wrap is this
    // component's job because only it knows how long a pool is.
    renderLine('fetching');
    const seen: string[] = [textOf()];
    for (let i = 0; i < 7; i += 1) {
      advanceOneSlot();
      seen.push(textOf());
    }
    // Two stage lines, cycling, so slot 4 is back to the first.
    expect(seen[4]).toBe(EN.headerNarration.stages.fetching[0]);
    expect(seen.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
  });

  it('starts the nudge pool at the seeded offset, not always at nudge 0', () => {
    seedNudgeAt(3);
    renderLine('fetching');
    advanceOneSlot();
    expect(textOf()).toBe(EN.headerNarration.nudges[3]);
  });

  it('switches pool when the stage changes, and opens that pool on its FIRST line', () => {
    const { rerender } = renderLine('fetching');
    advanceOneSlot(); // nudge
    rerender(<HeaderNarrationLine stage="grouping" onDevice={false} />);
    advanceOneSlot(); // the next stage slot, now grouping
    expect(textOf()).toBe(EN.headerNarration.stages.grouping[0]);
  });

  it('shows the on-device copy for analysing when the work is local', () => {
    renderLine('analysing', true);
    expect(textOf()).toBe(EN.headerNarration.stages.onDevice[0]);
    expect(textOf()).not.toBe(EN.headerNarration.stages.analysing[0]);
  });

  it('does not use the on-device copy for any other stage', () => {
    renderLine('downloading', true);
    expect(textOf()).toBe(EN.headerNarration.stages.downloading[0]);
  });
});

describe('HeaderNarrationLine — the crossfade', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    seedNudgeAt(0);
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders exactly ONE line at every instant, including mid-swap', () => {
    // The bug this exists for: a keyed entering/exiting pair leaves the old
    // copy painted while the new one mounts, and in a PINNED row that is two
    // sentences overlapping with nowhere to go.
    renderLine('fetching');
    expect(screen.getAllByTestId('header-narration-line')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(NARRATION_CYCLE_MS);
    });
    // At the trough: faded out, not yet swapped.
    expect(screen.getAllByTestId('header-narration-line')).toHaveLength(1);
    act(() => {
      jest.advanceTimersByTime(NARRATION_FADE_MS);
    });
    expect(screen.getAllByTestId('header-narration-line')).toHaveLength(1);
  });

  it('swaps the text at the TROUGH, not when the fade begins', () => {
    renderLine('fetching');
    const first = textOf();
    act(() => {
      jest.advanceTimersByTime(NARRATION_CYCLE_MS);
    });
    // Fade has started; the old sentence is still the one on screen.
    expect(textOf()).toBe(first);
    act(() => {
      jest.advanceTimersByTime(NARRATION_FADE_MS);
    });
    expect(textOf()).not.toBe(first);
  });

  it('leaves no armed swap behind on unmount — unmount IS the end of a run', () => {
    const { unmount } = renderLine('fetching');
    act(() => {
      jest.advanceTimersByTime(NARRATION_CYCLE_MS);
    });
    unmount();
    // A swap left armed repaints into a header that is showing its title again.
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('HeaderNarrationLine — reduced motion', () => {
  beforeEach(() => {
    mockReduceMotion = true;
    seedNudgeAt(0);
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // THE DIVERGENCE FROM ChatPhaseLine, which stops rotating entirely. Safe
  // there because the phase keeps changing underneath. Here `analysing` can
  // sit for a minute with NO TITLE on screen, so freezing would leave a
  // title-less header on one sentence for a minute, and no nudge ever.
  it('KEEPS rotating the text with the crossfade off', () => {
    renderLine('fetching');
    const first = textOf();
    act(() => {
      jest.advanceTimersByTime(REDUCED_MOTION_CYCLE_MS);
    });
    expect(textOf()).not.toBe(first);
    expect(textOf()).toBe(EN.headerNarration.nudges[0]);
  });

  it('swaps instantly, with no trough to wait through', () => {
    renderLine('fetching');
    act(() => {
      jest.advanceTimersByTime(REDUCED_MOTION_CYCLE_MS);
    });
    // No second advance needed: the text has already changed.
    expect(textOf()).toBe(EN.headerNarration.nudges[0]);
  });

  it('holds each line LONGER than it does with the crossfade on', () => {
    // A hard cut gives the eye no warning, so the sentence needs more dwell.
    expect(REDUCED_MOTION_CYCLE_MS).toBeGreaterThan(NARRATION_CYCLE_MS);
  });

  it('has not simply stopped: the reduced-motion clock really is running', () => {
    // The positive control for the three above. If the interval were dead,
    // "keeps rotating" would be the only failing test and the other two would
    // look like passing evidence of correct behaviour.
    renderLine('fetching');
    const seen = new Set<string>([textOf()]);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        jest.advanceTimersByTime(REDUCED_MOTION_CYCLE_MS);
      });
      seen.add(textOf());
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('HeaderNarrationLine — accessibility and clamping', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    seedNudgeAt(0);
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('carries ONE stable label that does not change as the line rotates', () => {
    renderLine('fetching');
    const node = screen.getByTestId('header-narration-line');
    expect(node.props.accessibilityLabel).toBe(EN.headerNarration.a11y);
    advanceOneSlot();
    expect(screen.getByTestId('header-narration-line').props.accessibilityLabel).toBe(
      EN.headerNarration.a11y,
    );
  });

  it('is NOT a live region — the reader is working a list, not watching a bubble', () => {
    renderLine('fetching');
    expect(
      screen.getByTestId('header-narration-line').props.accessibilityLiveRegion,
    ).toBeUndefined();
  });

  it('clamps to the two lines the pinned row has room for', () => {
    renderLine('fetching');
    const node = screen.getByTestId('header-narration-line');
    expect(node.props.numberOfLines).toBe(HEADER_NARRATION_METRICS.maxLines);
    expect(node.props.style).toEqual(
      expect.objectContaining({
        fontSize: HEADER_NARRATION_METRICS.fontSize,
        lineHeight: HEADER_NARRATION_METRICS.lineHeight,
      }),
    );
  });
});

describe('HeaderNarrationLine — the Dashboard row', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    seedNudgeAt(0);
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is one line in the row layout, and white', () => {
    render(<HeaderNarrationLine stage="fetching" onDevice={false} layout="row" />);
    const node = screen.getByTestId('header-narration-line');
    expect(node.props.numberOfLines).toBe(1);
    expect(node.props.style).toEqual(expect.objectContaining({ color: '#FFFFFF' }));
  });

  it('lets a caller lift the clamp for a large text size', () => {
    render(<HeaderNarrationLine stage="fetching" onDevice={false} layout="row" maxLines={3} />);
    expect(screen.getByTestId('header-narration-line').props.numberOfLines).toBe(3);
  });

  it('fades in 150ms each way, so the unreadable trough is short', () => {
    const { NARRATION_FADE_MS: fade } = require('../header-narration');
    expect(fade).toBe(150);
  });
});
