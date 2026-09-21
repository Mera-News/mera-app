// The wait line's surface.
//
// `jest.setup.js` does NOT mock react-native-reanimated: importing it throws on
// the uninitialised worklets native module and the error points at the import
// rather than the cause. This file carries its own, modelled on
// `processing/__tests__/ProcessingArea.test.tsx`, including the per-instance
// shared value. A mock that forgot the value between renders would make the
// crossfade assertions vacuous.
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
// below would pass vacuously against a pool that cannot rotate.
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
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { PHASE_CYCLE_MS } from '../chat-phases';
import ChatPhaseLine from '../ChatPhaseLine';

// The real dictionary, through the global i18n setup, so the strings asserted
// here are the strings that ship.
const EN = jest.requireActual('../../../../lib/locales/en.json') as {
  chatPhases: Record<string, string[]>;
};

describe('ChatPhaseLine', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    useChatPhaseStore.getState().reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('the three views', () => {
    it('renders the phase pool while a phase is published', () => {
      act(() => useChatPhaseStore.getState().setPhase('attesting'));
      render(<ChatPhaseLine />);
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.attesting[0],
      );
    });

    it('renders the OPENING pool when nothing has been published yet', () => {
      // Never an empty assistant bubble. A caller that forgets to publish
      // degrades to a sentence that is true of every turn either way.
      render(<ChatPhaseLine />);
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.preparing[0],
      );
    });

    it('renders NOTHING once released', () => {
      // The opposite of the case above, and conflating the two is the bug.
      // A fallback here flashes the opening sentence for a frame at the exact
      // moment real text arrives, which is a backwards walk.
      act(() => useChatPhaseStore.getState().setPhase('thinking'));
      act(() => useChatPhaseStore.getState().release());
      render(<ChatPhaseLine />);
      expect(screen.queryByTestId('chat-phase-line')).toBeNull();
    });
  });

  describe('rotation', () => {
    it('advances through the pool', () => {
      act(() => useChatPhaseStore.getState().setPhase('preparing'));
      render(<ChatPhaseLine />);
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.preparing[0],
      );

      act(() => {
        jest.advanceTimersByTime(PHASE_CYCLE_MS + 500);
      });
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.preparing[1],
      );
    });

    it('restarts at the first line when the phase changes', () => {
      // A new pool must never open mid-rotation on an index belonging to the
      // pool before it.
      act(() => useChatPhaseStore.getState().setPhase('preparing'));
      render(<ChatPhaseLine />);
      act(() => {
        jest.advanceTimersByTime(PHASE_CYCLE_MS + 500);
      });
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.preparing[1],
      );

      act(() => useChatPhaseStore.getState().setPhase('thinking'));
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.thinking[0],
      );
    });

    it('does NOT rotate under reduced motion, but still follows the phase', () => {
      // Someone who asked for less motion did not mean "except in text". The
      // phase itself is state, not decoration, and still changes: that is the
      // same thing the steps box does when it adds a row.
      mockReduceMotion = true;
      act(() => useChatPhaseStore.getState().setPhase('preparing'));
      render(<ChatPhaseLine />);

      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.preparing[0],
      );

      act(() => useChatPhaseStore.getState().setPhase('thinking'));
      expect(screen.getByTestId('chat-phase-line')).toHaveTextContent(
        EN.chatPhases.thinking[0],
      );
    });

    it('leaves no timer armed after unmount', () => {
      // A swap left armed repaints after the bubble has gone. Same class as
      // the streaming render queue's `armed` latch.
      act(() => useChatPhaseStore.getState().setPhase('preparing'));
      const view = render(<ChatPhaseLine />);
      act(() => {
        jest.advanceTimersByTime(PHASE_CYCLE_MS + 500);
      });
      view.unmount();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
