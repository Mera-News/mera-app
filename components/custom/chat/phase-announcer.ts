// The ONE source of chat wait speech, on both platforms.
//
// The wait row and the steps box carry no live region: a live region speaks
// every label change, and the phase walks preparing -> securing -> thinking in
// well under a second on a warm turn. Here a status is spoken only once it has
// held for `ANNOUNCE_HOLD_MS`, a retry is spoken at once, the same words are
// never spoken twice in a row, and nothing is spoken once the turn released
// its line (the answer is on screen). Turn boundaries come from the phase
// store: `idle` opens a turn, `released` ends it.

import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useEffect } from 'react';
import { AccessibilityInfo } from 'react-native';

export const ANNOUNCE_HOLD_MS = 1000;

export interface Announcer {
  /** The current status words. `urgent` speaks at once (a retry). */
  offer(text: string | null, opts?: { urgent?: boolean }): void;
  /** A turn opened: speech allowed again. */
  start(): void;
  /** The answer is on screen: nothing more this turn. */
  stop(): void;
}

export function createAnnouncer(
  speak: (text: string) => void,
  holdMs: number = ANNOUNCE_HOLD_MS,
): Announcer {
  let stopped = false;
  let lastSpoken: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const say = (text: string) => {
    lastSpoken = text;
    speak(text);
  };
  return {
    offer(text, opts) {
      clear();
      if (stopped || text === null || text === lastSpoken) return;
      if (opts?.urgent) {
        say(text);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) say(text);
      }, holdMs);
    },
    start() {
      clear();
      stopped = false;
      lastSpoken = null;
    },
    stop() {
      clear();
      stopped = true;
    },
  };
}

let shared: Announcer | null = null;

/** The app's announcer, bound to the phase store's turn boundaries. */
export function chatAnnouncer(): Announcer {
  if (shared) return shared;
  const announcer = createAnnouncer((text) => AccessibilityInfo.announceForAccessibility(text));
  useChatPhaseStore.subscribe((s, prev) => {
    if (s.view.kind === prev.view.kind) return;
    if (s.view.kind === 'idle') announcer.start();
    else if (s.view.kind === 'released') announcer.stop();
  });
  shared = announcer;
  return announcer;
}

/** Offer `text` whenever it changes. Null offers nothing and cancels a pending one. */
export function useAnnounce(text: string | null, urgent = false): void {
  useEffect(() => {
    chatAnnouncer().offer(text, { urgent });
  }, [text, urgent]);
}
