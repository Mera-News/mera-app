// The proposal card is rebuilt from what the SANITIZER staged, never from what the model asked
// for. Before the result echoed its sanitized `actions`, `deriveProposal` rebuilt the card from
// the tool INPUT, so an outlet the sanitizer dropped, or a structured filter value it downgraded,
// was drawn on the card and applied by Confirm. Walks every ProposalAction kind from staging
// through derivation, and Confirm's apply through the real executor.
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ProposalAction, StagedProposal, ToolCallRecord } from '@/lib/llm/types';
import type { ActiveSuppressionView, ToolExecutionResult } from '@/lib/news-harness/core/types';
import {
  decidePersonaProposeChanges,
  normalizePublicationNameForMatch,
} from '@/lib/news-harness/persona-management/persona-agent-core';
import { decideProposeChanges, decideProposeTrack } from '@/lib/news-harness/article-feedback/agent-core';
import { decideProposeFactCheck, makeFactCheckSubject } from '@/lib/news-harness/fact-check';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import {
  deriveFactCheckProposal,
  deriveProposal,
  deriveTrackProposal,
} from '@/components/custom/floating-chat/derive-proposals';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import * as suppressions from '@/lib/database/services/suppression-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, setProcessingMode } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  await setProcessingMode('cloud');
  await signInFixtureAccount();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function call(name: string, input: Record<string, unknown>, out: ToolExecutionResult): ToolCallRecord {
  return { id: `tc-${name}`, name, input, result: out.result as Record<string, unknown>, status: 'done' };
}

/** The proposal card the thread draws for one assistant message carrying `tc`. */
function cardFor(tc: ToolCallRecord): StagedProposal {
  const items = deriveThreadItems({
    live: [
      { id: 'u1', role: 'user', content: 'hi' },
      { id: 'a1', role: 'assistant', content: 'Here is the change.', toolCalls: [tc] },
    ],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
  });
  const card = items.find((i) => i.kind === 'proposal-card');
  if (!card || card.kind !== 'proposal-card') throw new Error('no proposal card derived');
  return card.proposal;
}

const KNOWN_OUTLETS = new Set([normalizePublicationNameForMatch('The Hindu')]);

describe('the card shows and applies only what the sanitizer staged', () => {
  it('persona chat: an invented outlet is neither drawn nor applied, a known one is', async () => {
    const input = {
      explanation: 'Less of these.',
      expected_effects: 'Fewer stories from them.',
      actions: [
        { type: 'set_publication_pref', publicationId: 'The Daily Imaginary', publicationPref: 'mute' },
        { type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'deprioritize' },
      ],
    };
    const staged = decidePersonaProposeChanges(input, [], KNOWN_OUTLETS);
    const card = cardFor(call('proposeChanges', input, staged));

    expect(card.actions).toEqual([
      { type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'deprioritize' },
    ]);

    // Confirm applies exactly the card's actions (ProposalCard.handleConfirm).
    await executeProposalActions(card.actions, { confirmedByUser: true });
    expect(await getPreferenceKind('The Daily Imaginary')).toBe('none');
    expect(await getPreferenceKind('The Hindu')).toBe('deprioritize');
  });

  it('persona chat: a structured filter value the model sent is dropped from the card (keyword only)', async () => {
    const input = {
      explanation: 'Hide it.',
      expected_effects: 'No more of it.',
      actions: [
        { type: 'add_suppression', suppressionPattern: 'celebrity gossip', suppressionKind: 'category', suppressionValue: 'Entertainment' },
      ],
    };
    const card = cardFor(call('proposeChanges', input, decidePersonaProposeChanges(input, [], KNOWN_OUTLETS)));

    expect(card.actions).toEqual([{ type: 'add_suppression', suppressionPattern: 'celebrity gossip' }]);
    await executeProposalActions(card.actions, { confirmedByUser: true });
    const [row] = await suppressions.getActive();
    expect(suppressions.kindOf(row)).toBe('keyword');
  });

  it('article chat: an uncorroborated structured value stays downgraded on the card', () => {
    const input = {
      explanation: 'Hide it.',
      expected_effects: 'No more of it.',
      actions: [
        { type: 'add_suppression', suppressionPattern: 'Taylor Swift', suppressionKind: 'entity', suppressionValue: 'Taylor Swift' },
      ],
    };
    const staged = decideProposeChanges(input, new Set(), { article: null, activeSuppressions: [] });
    const card = cardFor(call('proposeChanges', input, staged));

    expect(card.actions).toEqual([{ type: 'add_suppression', suppressionPattern: 'Taylor Swift' }]);
  });

  it('a row persisted before the echo existed still renders from its input', () => {
    const input = {
      explanation: 'Mute it.',
      expected_effects: 'Gone.',
      actions: [{ type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'mute' }],
    };
    const legacy: ToolCallRecord = {
      id: 'tc-legacy',
      name: 'proposeChanges',
      input,
      result: { staged: true, actionCount: 1, proposalId: 'proposal-old' },
      status: 'done',
    };

    expect(cardFor(legacy).actions).toEqual(input.actions);
    expect(cardFor(legacy).id).toBe('proposal-old');
  });
});

// ---------------------------------------------------------------------------
// Every kind, staged then derived. Keyed by ProposalAction['type'], so adding a
// kind without a row here is a compile error rather than a card that silently
// drops it on resume.
// ---------------------------------------------------------------------------

const ARTICLE_FACTS = new Set(['f1']);
const FILTER: ActiveSuppressionView = { id: 's1', pattern: 'crypto', kind: 'keyword', value: null, strength: 0.9 };
const TRACK_SUBJECT = {
  origin: 'suggestion' as const,
  surface: 'detail',
  articleId: 'a-1',
  title: 'Dutch coalition talks',
  pubDate: '2026-10-01T00:00:00Z',
  stableClusterId: 'sc-1',
  publicationName: 'NOS',
};

function viaArticle(action: Record<string, unknown>): ToolCallRecord {
  const input = { explanation: 'x', expected_effects: 'y', actions: [action] };
  return call('proposeChanges', input, decideProposeChanges(input, ARTICLE_FACTS, { activeSuppressions: [FILTER] }));
}

function viaPersona(action: Record<string, unknown>): ToolCallRecord {
  const input = { explanation: 'x', expected_effects: 'y', actions: [action] };
  return call('proposeChanges', input, decidePersonaProposeChanges(input, [FILTER], KNOWN_OUTLETS));
}

const STAGE: Record<ProposalAction['type'], () => ToolCallRecord> = {
  add_fact: () => viaArticle({ type: 'add_fact', statement: 'Works as a nurse' }),
  update_fact: () => viaArticle({ type: 'update_fact', fact_id: 'f1', new_statement: 'Lives in Utrecht' }),
  delete_fact: () => viaArticle({ type: 'delete_fact', fact_id: 'f1' }),
  add_topics: () => viaArticle({ type: 'add_topics', fact_id: 'f1', topics: ['Utrecht news'] }),
  remove_topics: () => viaArticle({ type: 'remove_topics', fact_id: 'f1', topics: ['Utrecht news'] }),
  submit_feature_request: () =>
    viaArticle({ type: 'submit_feature_request', title: 'Dark widgets', summary: 'Offer a dark home widget.' }),
  set_topic_weight: () => viaArticle({ type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 }),
  add_negative_topic: () => viaArticle({ type: 'add_negative_topic', topicText: 'Delhi crime' }),
  set_publication_pref: () =>
    viaPersona({ type: 'set_publication_pref', publicationId: 'The Hindu', publicationPref: 'mute' }),
  set_source_scope_pref: () =>
    viaPersona({ type: 'set_source_scope_pref', scopeCountry: 'india', publicationPref: 'boost' }),
  add_suppression: () =>
    viaArticle({ type: 'add_suppression', suppressionPattern: 'lottery', suppressionKeywords: ['lottery'], suppressionStrength: 0.5 }),
  retire_suppression: () => viaPersona({ type: 'retire_suppression', suppressionId: 's1' }),
  set_high_priority: () => viaArticle({ type: 'set_high_priority', topicText: 'cricket', highPriority: true }),
  retire_topic: () => viaArticle({ type: 'retire_topic', topicText: 'cricket' }),
  set_fact_places: () =>
    viaArticle({ type: 'set_fact_places', fact_id: 'f1', places: [{ level: 'country', country: 'India' }] }),
  // PersonaUpdateAgent.runCalibration stages a literal proposal; its card is a proposeChanges card.
  run_calibration: () => {
    const proposal: StagedProposal = { id: 'p-cal', explanation: 'x', expectedEffects: 'y', actions: [{ type: 'run_calibration' }] };
    return call('proposeChanges', { explanation: 'x', expected_effects: 'y', actions: proposal.actions }, {
      result: { staged: true, proposalId: proposal.id },
      sideEffects: { proposal },
    });
  },
  track_story: () => {
    const input = { options: [{ label: 'Dutch coalition talks', search: 'Dutch coalition formation talks' }] };
    return call('proposeTrack', input, decideProposeTrack(input, TRACK_SUBJECT));
  },
  fact_check_claim: () => {
    const input = { options: [{ label: 'Turnout record', claim: 'Turnout was the highest since 1977.' }] };
    const subject = makeFactCheckSubject({ articleId: 'a-1', title: 'Dutch election results' });
    return call('proposeFactCheck', input, decideProposeFactCheck(input, subject, 'The whole article'));
  },
};

describe('every action kind survives staging and derivation unchanged', () => {
  it.each(Object.keys(STAGE) as ProposalAction['type'][])('%s', (kind) => {
    const tc = STAGE[kind]();
    expect(typeof (tc.result as Record<string, unknown>).error).not.toBe('string');

    const card = deriveProposal(tc) ?? deriveTrackProposal(tc) ?? deriveFactCheckProposal(tc);
    expect(card).not.toBeNull();
    const derived = card!.actions.filter((a) => a.type === kind);
    expect(derived.length).toBeGreaterThan(0);

    // proposeChanges echoes its sanitized actions; the card must equal them exactly.
    const echoed = (tc.result as Record<string, unknown>).actions;
    if (tc.name === 'proposeChanges' && Array.isArray(echoed)) {
      expect(card!.actions).toEqual(echoed);
    }
  });

  it('the executor has a branch for every kind', () => {
    const source = readFileSync(join(__dirname, '../../../../../lib/chat-tools/proposal-handlers.ts'), 'utf8');
    for (const kind of Object.keys(STAGE)) {
      expect(source).toContain(`case '${kind}':`);
    }
  });
});
