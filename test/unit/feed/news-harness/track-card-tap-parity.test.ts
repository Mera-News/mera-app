// track-card-tap-parity.test.ts — A15: the cloud prompts and the on-device
// pending line tell the model the SAME thing about a follow card, so the two
// engines cannot drift apart on whether the user picks one or several.
// The cloud SYSTEM prompts are deliberately not carriers: the wording there
// measured worse on staging (D8), so they keep their shipped bytes and the
// multi-select truth reaches the model only while a card is on screen.

import { chooseOneRefusal, TRACK_CARD_TAP_PHRASE } from '@/lib/news-harness/core/proposals';
import type { StagedProposal } from '@/lib/news-harness/core/types';
import { buildFollowStoryContext } from '@/lib/news-harness/follow-story';
import { buildFeedbackContext } from '@/lib/news-harness/article-feedback/agent-core';
import { describePending } from '@/lib/news-harness/on-device/shared';

const trackCard: StagedProposal = {
  id: 'p-track',
  explanation: '',
  expectedEffects: '',
  chooseOne: true,
  actions: ['Bridge repairs', 'City roadworks'].map((label) => ({
    type: 'track_story' as const,
    label,
    searchText: label,
    subject: { origin: 'article' as const, surface: 'detail', articleId: 'a1', title: 't' },
  })),
};

describe('follow card wording parity (A15)', () => {
  it.each([
    ['cloud follow pending line', () => buildFollowStoryContext({ nowMs: 0, proposal: trackCard })],
    [
      'cloud article pending line',
      () =>
        buildFeedbackContext({
          nowMs: 0,
          facts: [],
          context: null,
          fallbackTitle: 'Harbour bridge closes',
          proposal: trackCard,
        }),
    ],
    ['on-device pending line', () => describePending(trackCard) ?? ''],
    ['applyProposal refusal', () => chooseOneRefusal(trackCard).message],
  ])('%s carries the tap phrase', (_where, build) => {
    expect(build()).toContain(TRACK_CARD_TAP_PHRASE);
  });
});
