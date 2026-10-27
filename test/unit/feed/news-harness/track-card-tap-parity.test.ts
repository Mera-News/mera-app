// track-card-tap-parity.test.ts — A15: the cloud prompts and the on-device
// pending line tell the model the SAME thing about a follow card, so the two
// engines cannot drift apart on whether the user picks one or several.

import { TRACK_CARD_TAP_PHRASE } from '@/lib/news-harness/core/proposals';
import type { StagedProposal } from '@/lib/news-harness/core/types';
import { buildFollowStoryContext, buildFollowStorySystemPrompt } from '@/lib/news-harness/follow-story';
import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
} from '@/lib/news-harness/article-feedback/agent-core';
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
    ['cloud follow system prompt', () => buildFollowStorySystemPrompt({ needsToolFormat: false, canSearch: true })],
    ['cloud follow pending line', () => buildFollowStoryContext({ nowMs: 0, proposal: trackCard })],
    ['cloud article system prompt', () => buildArticleFeedbackSystemPrompt({ needsToolFormat: false })],
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
  ])('%s carries the tap phrase', (_where, build) => {
    expect(build()).toContain(TRACK_CARD_TAP_PHRASE);
  });
});
