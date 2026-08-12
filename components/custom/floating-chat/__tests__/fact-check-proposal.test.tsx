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
// check spends up to three searches and a synthesis call (or, on the article
// pill, a server-side job), so no model-driven path may start one.
//
// pivot P8c: the card now ALWAYS ends with a whole-article pill, and the two
// pills go to different places — the claim one answers in the thread, the
// article one lodges a server check whose result the Dashboard carries. Both
// paths are covered below, because rendering them identically is exactly how a
// reader would come to believe the fast web summary was the thorough check.

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
// The check itself is required LAZILY by the executor (it drags the search +
// inference graphs), so it is mocked at that seam: this file's job is to pin
// that the executor REACHES it, not to re-test what it does — that is
// lib/chat-tools/__tests__/quick-fact-check-handler.test.ts.
const mockStartFactCheck = jest.fn();
jest.mock('@/lib/chat-tools/quick-fact-check-handler', () => ({
  startFactCheckFromAction: mockStartFactCheck,
}));

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
const ARTICLE_OPTION_LABEL = 'The Article (async)';

const ACTION: ProposalAction = {
  type: 'fact_check_claim',
  label: OPTIONS[0].label,
  claim: OPTIONS[0].claim,
  subject: SUBJECT,
};

/** The always-last pill: no claim, the whole article, the SERVER path. */
const ARTICLE_ACTION: ProposalAction = {
  type: 'fact_check_claim',
  label: ARTICLE_OPTION_LABEL,
  claim: '',
  subject: SUBJECT,
  mode: 'article',
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

  // The two pills promise DIFFERENT things — a quick web summary answered in the
  // thread vs. a thorough server check that lands in the Dashboard. A row that
  // read "Check this claim" over the article pill would sell one as the other.
  it('gives the article pill its own label and icon', () => {
    const row = actionToRow(ARTICLE_ACTION);

    expect(row.labelKey).toBe('factCheck.actionCheckArticle');
    expect(row.labelKey).not.toBe(actionToRow(ACTION).labelKey);
    expect(row.icon).not.toBe(actionToRow(ACTION).icon);
    expect(row.heading).toBe(ARTICLE_OPTION_LABEL);
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
    const live = decideProposeFactCheck({ options: OPTIONS }, SUBJECT, ARTICLE_OPTION_LABEL);
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

  // The article pill exists ONLY in the staged (echoed) options — the model
  // never emits it, so the tool INPUT does not carry it. A resume that read
  // `input.options` in preference would drop the thorough path off the card.
  it('rebuilds the whole-article pill, which the tool input never carried', () => {
    const live = decideProposeFactCheck({ options: OPTIONS }, SUBJECT, ARTICLE_OPTION_LABEL);
    const card = derive({
      id: 'tc-fc-article',
      name: 'proposeFactCheck',
      status: 'done',
      input: { options: OPTIONS },
      result: live.result as Record<string, unknown>,
    });

    expect(card && card.kind === 'proposal-card' && card.proposal.actions).toHaveLength(3);
    if (card && card.kind === 'proposal-card') {
      const last = card.proposal.actions[2];
      expect(last.type).toBe('fact_check_claim');
      if (last.type === 'fact_check_claim') {
        expect(last.mode).toBe('article');
        expect(last.label).toBe(ARTICLE_OPTION_LABEL);
      }
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
  beforeEach(() => mockStartFactCheck.mockClear());

  it('hands the tapped action straight through and never falls through', async () => {
    const result = await executeProposalActions([ACTION], { confirmedByUser: true });

    // The WHOLE action, not a re-derived payload: the article snapshot is
    // embedded in it, so the starter needs no store read.
    expect(mockStartFactCheck).toHaveBeenCalledWith(ACTION);
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
    for (const err of result.errors) expect(err).not.toContain('unknown action type');
  });

  it('runs the article pill too, despite its empty claim', async () => {
    const result = await executeProposalActions([ARTICLE_ACTION], { confirmedByUser: true });

    expect(mockStartFactCheck).toHaveBeenCalledWith(ARTICLE_ACTION);
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('errors (and starts nothing) on an empty CLAIM pill', async () => {
    const result = await executeProposalActions([{ ...ACTION, claim: '  ' }], {
      confirmedByUser: true,
    });

    expect(mockStartFactCheck).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.errors).toEqual(['fact_check_claim: empty claim']);
  });

  // The article pill's payload IS the article id, so that is what it is guarded
  // on — a resumed card with no subject must not lodge a server check on ''.
  it('errors on an article pill with no articleId', async () => {
    const result = await executeProposalActions(
      [{ ...ARTICLE_ACTION, subject: makeFactCheckSubject({ articleId: '', title: 'T' }) }],
      { confirmedByUser: true },
    );

    expect(mockStartFactCheck).not.toHaveBeenCalled();
    expect(result.errors).toEqual(['fact_check_claim: empty articleId']);
  });

  // THE consent rule. Without `confirmedByUser` this is a model-driven path, and
  // a model-driven path must never start a check.
  it('refuses to run without an explicit user tap', async () => {
    const result = await executeProposalActions([ACTION]);

    expect(mockStartFactCheck).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });
});

describe('the staged card is always single-select', () => {
  it('treats a multi-claim card as requiring a tap', () => {
    const staged = decideProposeFactCheck({ options: OPTIONS }, SUBJECT, ARTICLE_OPTION_LABEL)
      .sideEffects!.proposal!;

    expect(proposalRequiresUserChoice(staged)).toBe(true);
  });

  // The "user typed their own claim" card used to be a plain confirm, and
  // USER_CONFIRMED_ONLY_ACTIONS was the only thing standing between it and a
  // model-applied check. Appending the article pill makes even that card a
  // choice of two, so `proposalRequiresUserChoice` — the guard every
  // applyProposal calls — now covers every fact-check card there is. The
  // executor's refusal above is the belt to this braces.
  it('treats a LONE typed claim as a choice too, once the article pill is added', () => {
    const staged = decideProposeFactCheck(
      { options: [OPTIONS[0]] },
      SUBJECT,
      ARTICLE_OPTION_LABEL,
    ).sideEffects!.proposal!;

    expect(staged.actions).toHaveLength(2);
    expect(proposalRequiresUserChoice(staged)).toBe(true);
  });
});
