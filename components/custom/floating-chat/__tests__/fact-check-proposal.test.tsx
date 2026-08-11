// `fact_check_claim` — the three-consumer coverage test.
//
// WHY THIS FILE EXISTS SEPARATELY. `proposal-action-coverage.test.tsx` walks the
// `proposeChanges` action-type ENUM, and `fact_check_claim` is not in it (nor is
// `track_story`) — both are staged by their own tool, so the enum walk gives
// them zero coverage. The three consumers that tsc does NOT check are therefore
// unguarded for this action unless it is checked here:
//
//   1. ProposalCard.actionToRow — a missing case falls through to the
//      exhaustiveness guard and silently renders a bare, detail-less "tune" row;
//   2. deriveThreadItems — a missing derivation makes a RESUMED card not render
//      at all, and a derivation that disagrees with the live path rebuilds
//      DIFFERENT actions from the same persisted call;
//   3. proposal-handlers.executeProposalActions — a missing case only fails at
//      runtime, with `unknown action type` and `applied: 0`.
//
// It also pins the consent rule, which is the expensive one to get wrong: a
// check spends a lookup, up to three searches and a thinking synthesis, so no
// model-driven path may start one.

/* eslint-disable @typescript-eslint/no-require-imports */

// ── proposal-handlers seams (mirrors proposal-action-coverage.test.tsx) ──
jest.mock('@/lib/database/services/fact-service', () => ({
  addFact: jest.fn(() => Promise.resolve({ id: 'f-new', statement: 's' })),
  deleteFact: jest.fn(() => Promise.resolve()),
  getFacts: jest.fn(() => Promise.resolve([])),
  updateFact: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: { getState: jest.fn(() => ({ notifyFactMutation: jest.fn() })) },
}));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ triggerTopicGeneration: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/feedback', () => ({ submitFeatureRequest: jest.fn(() => true) }));
jest.mock('@/lib/database/services/topic-service', () => ({
  getAllByNormalizedText: jest.fn(() => Promise.resolve([])),
}));
jest.mock('@/lib/database/services/persona-action-executor', () => ({
  applyPersonaAction: jest.fn(() => Promise.resolve({ applied: true, summary: 'ok' })),
}));
jest.mock('@/lib/tracking/track-actions', () => ({
  trackStoryWithProposal: jest.fn(() => Promise.resolve()),
}));
// The queue is owned by another unit of this wave and is required LAZILY by the
// executor, so it is mocked `virtual` — this test pins OUR call against the
// agreed signature and stays green whether or not that module has landed.
const mockEnqueueFactCheck = jest.fn(() =>
  Promise.resolve({ factCheckId: 'fc-1', claimKey: 'ck-1' }),
);
jest.mock(
  '@/lib/fact-check/fact-check-queue',
  () => ({ enqueueFactCheck: mockEnqueueFactCheck }),
  { virtual: true },
);

// ── ProposalCard's RN/UI seams (actionToRow is pure; the module is not) ──
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: (p: Record<string, unknown>) => <Pressable {...p} />,
    ButtonText: (p: Record<string, unknown>) => <Text {...p} />,
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: ({ entering: _e, ...p }: Record<string, unknown>) => <View {...p} /> },
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/lib/haptics', () => ({ hapticSuccess: jest.fn() }));
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text }: Record<string, unknown>) => <Text>{text as string}</Text>,
  };
});

import { actionToRow } from '../ProposalCard';
import { deriveThreadItems } from '../deriveThreadItems';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { decideProposeFactCheck, makeFactCheckSubject } from '@/lib/news-harness/fact-check';
import { proposalRequiresUserChoice } from '@/lib/news-harness/core/proposals';
import type { ConversationMessage, ProposalAction, ToolCallRecord } from '@/lib/llm/types';

const ARTICLE = {
  articleId: 'art-1',
  title: 'RFK Jr. says children receive 80 vaccines by age 18',
  description: 'The health secretary told a Senate hearing the schedule has tripled since 1986.',
  url: 'https://example.com/story',
  publicationName: 'France 24',
};
const SUBJECT = makeFactCheckSubject(ARTICLE);

const OPTIONS = [
  { label: '80 vaccines by age 18', claim: 'Children in the US receive 80 different vaccines by age 18.' },
  { label: 'Schedule tripled since 1986', claim: 'The US childhood vaccine schedule has tripled since 1986.' },
];

const ACTION: ProposalAction = {
  type: 'fact_check_claim',
  label: OPTIONS[0].label,
  claim: OPTIONS[0].claim,
  subject: SUBJECT,
};

// ---------------------------------------------------------------------------
// 1. ProposalCard.actionToRow — the silent-guard trap
// ---------------------------------------------------------------------------

describe('ProposalCard renders a labelled row for fact_check_claim', () => {
  it('does not fall through to the exhaustiveness guard', () => {
    const row = actionToRow(ACTION);

    // `articleFeedback.proposalTitle` is the card HEADER key, reused by the
    // guard — a row wearing it is an unhandled type rendering as a bare "tune".
    expect(row.labelKey).not.toBe('articleFeedback.proposalTitle');
    expect(row.labelKey).toBe('factCheck.actionCheckClaim');
    expect(row.icon).toBe('fact-check');
  });

  it('shows the pill LABEL as the heading and never the raw claim', () => {
    const row = actionToRow(ACTION);

    expect(row.heading).toBe(OPTIONS[0].label);
    // Display-translated: the claim is the English search key and is read from
    // the ACTION, never from this row, so translating the heading is safe.
    expect(row.translateHeading).toBe(true);
    expect(row.detail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. deriveThreadItems — the resume path must rebuild the LIVE actions
// ---------------------------------------------------------------------------

function assistantMsg(id: string, toolCalls: ToolCallRecord[]): ConversationMessage {
  return { id, role: 'assistant', content: 'Pick a claim to check.', toolCalls };
}

function derive(toolCall: ToolCallRecord) {
  return deriveThreadItems({
    live: [assistantMsg('a1', [toolCall])],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier conversation',
  }).find((i) => i.kind === 'proposal-card');
}

describe('deriveThreadItems rebuilds a fact-check proposal from a persisted call', () => {
  it('rebuilds actions byte-identical to the live decide path', () => {
    const live = decideProposeFactCheck({ options: OPTIONS }, SUBJECT);
    const toolCall: ToolCallRecord = {
      id: 'tc-fc',
      name: 'proposeFactCheck',
      status: 'done',
      input: { options: OPTIONS },
      result: live.result as Record<string, unknown>,
    };

    const card = derive(toolCall);
    expect(card).toMatchObject({ kind: 'proposal-card' });
    if (card && card.kind === 'proposal-card') {
      // The echoed nonce wins over the tool-call id, so the card reconciles
      // against store.resolvedProposals exactly as the live card does.
      expect(card.proposal.id).toBe(live.result.proposalId);
      expect(card.proposal.actions).toEqual(live.sideEffects?.proposal?.actions);
      expect(card.proposal.chooseOne).toBe(true);
    }
  });

  it('still renders (dimmed, no subject) when the result was never persisted', () => {
    const card = derive({
      id: 'tc-fc2',
      name: 'proposeFactCheck',
      status: 'done',
      input: { options: OPTIONS },
    });

    expect(card).toMatchObject({ kind: 'proposal-card' });
    if (card && card.kind === 'proposal-card') {
      expect(card.proposal.id).toBe('tc-fc2'); // falls back to the tool-call id
      const action = card.proposal.actions[0];
      expect(action.type).toBe('fact_check_claim');
      // An EMPTY articleId, never a wrong one: the executor's guards see a blank
      // rather than another article's id.
      if (action.type === 'fact_check_claim') expect(action.subject.articleId).toBe('');
    }
  });

  it('emits nothing when no option survives parsing', () => {
    expect(
      derive({ id: 'tc-fc3', name: 'proposeFactCheck', status: 'done', input: { options: [] } }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. proposal-handlers — execution + the consent rule
// ---------------------------------------------------------------------------

describe('executeProposalActions runs fact_check_claim', () => {
  beforeEach(() => mockEnqueueFactCheck.mockClear());

  it('calls enqueueFactCheck with the agreed input and never falls through', async () => {
    const result = await executeProposalActions([ACTION], { confirmedByUser: true });

    expect(mockEnqueueFactCheck).toHaveBeenCalledWith({
      articleId: 'art-1',
      articleTitle: ARTICLE.title,
      articleUrl: ARTICLE.url,
      publicationName: 'France 24',
      claim: OPTIONS[0].claim,
    });
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
    for (const err of result.errors) expect(err).not.toContain('unknown action type');
  });

  it('omits the optional fields when the article had none', async () => {
    await executeProposalActions(
      [{ ...ACTION, subject: makeFactCheckSubject({ articleId: 'a', title: 'T' }) }],
      { confirmedByUser: true },
    );

    expect(mockEnqueueFactCheck).toHaveBeenCalledWith({
      articleId: 'a',
      articleTitle: 'T',
      claim: OPTIONS[0].claim,
    });
  });

  it('errors (and enqueues nothing) on an empty claim', async () => {
    const result = await executeProposalActions([{ ...ACTION, claim: '  ' }], {
      confirmedByUser: true,
    });

    expect(mockEnqueueFactCheck).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.errors).toEqual(['fact_check_claim: empty claim']);
  });

  // THE consent rule. Without `confirmedByUser` this is a model-driven path, and
  // a model-driven path must never start a background check.
  it('refuses to run without an explicit user tap', async () => {
    const result = await executeProposalActions([ACTION]);

    expect(mockEnqueueFactCheck).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });
});

describe('the staged card is single-select whenever it offers a choice', () => {
  it('treats a multi-claim card as requiring a tap', () => {
    const staged = decideProposeFactCheck({ options: OPTIONS }, SUBJECT).sideEffects!.proposal!;

    expect(proposalRequiresUserChoice(staged)).toBe(true);
  });

  // A lone claim (the "user typed their own" path) is not a CHOICE — the card
  // renders a plain confirm. USER_CONFIRMED_ONLY_ACTIONS is what still stops a
  // model applying it, which the refusal test above pins.
  it('treats a lone claim as a plain confirm', () => {
    const staged = decideProposeFactCheck({ options: [OPTIONS[0]] }, SUBJECT).sideEffects!.proposal!;

    expect(proposalRequiresUserChoice(staged)).toBe(false);
  });
});
