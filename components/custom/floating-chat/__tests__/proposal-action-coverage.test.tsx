// Action-type COVERAGE — the one test that would have caught the dead confirm path.
//
// Both LLM agents advertise a `proposeChanges` tool whose action `type` is a
// JSON-Schema enum. Three consumers must handle every member of that enum, and
// NONE of them is checked by tsc:
//
//   1. lib/chat-tools/proposal-handlers.executeProposalActions — its `default:`
//      branch casts, so a missing case compiles and only fails at runtime with
//      `unknown action type: …` and `applied: 0`;
//   2. deriveThreadItems.parseProposalAction — a missing case returns `null`,
//      which empties `actions` and makes a RESUMED proposal card not render;
//   3. ProposalCard.actionToRow — a missing case falls through to the
//      exhaustiveness guard and renders a bare, detail-less "tune" row.
//
// P4a shipped `retire_suppression` into both enums and into none of the three.
// A per-case test would have missed it the same way; walking the enum can't.
//
// The two enums are deliberately compared as SEPARATE sets: the persona agent
// exposes filters-only (`add_suppression` | `retire_suppression`) and
// intentionally omits suppressionKind/suppressionValue from its schema
// (persona-agent-core.test.ts asserts that), while the article-feedback agent
// exposes the full proposal surface.

/* eslint-disable @typescript-eslint/no-require-imports */

// ── proposal-handlers seams (mirrors lib/chat-tools/__tests__/proposal-handlers.test.ts) ──
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
  applyPersonaAction: jest.fn(() =>
    Promise.resolve({ applied: true, changeLogId: 'cl-1', summary: 'ok' }),
  ),
}));
jest.mock('@/lib/tracking/track-actions', () => ({
  trackStoryWithProposal: jest.fn(() => Promise.resolve()),
}));

// ── ProposalCard's RN/UI seams (actionToRow itself is pure, but the module
//    imports the gluestack/reanimated/expo-icon entries at load) ──
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
// `actionToRow` is pure, but importing it loads the component module — which now
// imports the display-translation wrapper, and through it `expo-translate-text`
// (no native module under jest). Stub it as a plain Text of the source string.
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text }: Record<string, unknown>) => <Text>{text as string}</Text>,
  };
});

import { actionToRow } from '../ProposalCard';
import { parseProposalAction } from '../deriveThreadItems';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { getArticleFeedbackToolDefinitions } from '@/lib/news-harness/article-feedback/agent-core';
import { getPersonaToolDefinitions } from '@/lib/news-harness/persona-management/persona-agent-core';
import type { ToolDefinition } from '@/lib/llm/types';

// ── Enum extraction (the runtime source of truth — the TS union is erased) ────

/** Pull `proposeChanges`'s action-type enum out of a tool-definition list. */
function proposalActionEnum(defs: ToolDefinition[]): string[] {
  const def = defs.find((d) => d.function.name === 'proposeChanges');
  expect(def).toBeDefined();
  const params = def!.function.parameters as unknown as {
    properties: {
      actions: { items: { properties: { type: { enum: string[] } } } };
    };
  };
  const values = params.properties.actions.items.properties.type.enum;
  expect(Array.isArray(values) && values.length > 0).toBe(true);
  return values;
}

const ARTICLE_FEEDBACK_ENUM = proposalActionEnum(getArticleFeedbackToolDefinitions());
const PERSONA_ENUM = proposalActionEnum(getPersonaToolDefinitions('CONFIG'));

/** Every action type either agent can stage. */
const ALL_ACTION_TYPES = Array.from(
  new Set([...ARTICLE_FEEDBACK_ENUM, ...PERSONA_ENUM]),
).sort();

/**
 * A minimal-but-VALID persisted action per type. Deliberately hand-written (not
 * generated): a new enum member with no sample here fails the guard below, which
 * forces whoever adds it to teach this test what the payload looks like — and
 * therefore to notice the three consumers.
 */
const SAMPLES: Record<string, Record<string, unknown>> = {
  add_fact: { type: 'add_fact', statement: 'Lives in Berlin' },
  update_fact: { type: 'update_fact', fact_id: 'f1', new_statement: 'Lives in Munich' },
  delete_fact: { type: 'delete_fact', fact_id: 'f1' },
  add_topics: { type: 'add_topics', fact_id: 'f1', topics: ['ai'] },
  remove_topics: { type: 'remove_topics', fact_id: 'f1', topics: ['ai'] },
  submit_feature_request: { type: 'submit_feature_request', title: 't', summary: 's' },
  set_topic_weight: { type: 'set_topic_weight', topicText: 'cricket', delta: -0.2 },
  add_negative_topic: { type: 'add_negative_topic', topicText: 'celebrity gossip' },
  set_publication_pref: {
    type: 'set_publication_pref',
    publicationId: 'Daily Blether',
    publicationPref: 'mute',
  },
  add_suppression: {
    type: 'add_suppression',
    suppressionPattern: 'celebrity',
    suppressionKind: 'category',
    suppressionValue: 'Entertainment',
    suppressionStrength: 0.5,
  },
  retire_suppression: { type: 'retire_suppression', suppressionId: 'sup-1', pattern: 'football' },
  // source-pref v47: the PERSISTED args carry the model's English country NAME
  // (`scopeCountry`), not the resolved alpha-3 — parseProposalAction redoes the
  // resolution the sanitizer did, so this sample is deliberately in raw form.
  set_source_scope_pref: {
    type: 'set_source_scope_pref',
    scopeCountry: 'India',
    publicationPref: 'boost',
  },
  set_high_priority: { type: 'set_high_priority', topicText: 'cricket', highPriority: true },
  retire_topic: { type: 'retire_topic', topicText: 'cricket' },
};

describe('proposal action-type coverage', () => {
  it('has a sample for every type in both agents’ tool enums', () => {
    expect(ALL_ACTION_TYPES.every((t) => SAMPLES[t] !== undefined)).toBe(true);
    // Both enums are non-trivial and the filters actions are in both.
    //
    // source-pref P3 UPDATE: this used to assert the persona enum was a SUBSET
    // of the article one. That stopped being true by design —
    // `set_source_scope_pref` ("prefer Indian sources") is a PERSONA-only
    // action: the article surface always has one concrete outlet in front of
    // it, so its source lever is `set_publication_pref`, and a country scope
    // has nothing there to be about. The subset relation is asserted for
    // everything else, which is what the check was actually protecting.
    const PERSONA_ONLY = ['set_source_scope_pref'];
    expect(ARTICLE_FEEDBACK_ENUM).toEqual(
      expect.arrayContaining(PERSONA_ENUM.filter((t) => !PERSONA_ONLY.includes(t))),
    );
    expect(ARTICLE_FEEDBACK_ENUM).not.toEqual(expect.arrayContaining(PERSONA_ONLY));
    expect(PERSONA_ENUM).toEqual(
      expect.arrayContaining([
        'add_suppression',
        'retire_suppression',
        'set_publication_pref',
        'set_source_scope_pref',
      ]),
    );
  });

  it.each(ALL_ACTION_TYPES)(
    'proposal-handlers executes "%s" (never falls through to default:)',
    async (type) => {
      const parsed = parseProposalAction(SAMPLES[type]);
      expect(parsed).not.toBeNull();
      const result = await executeProposalActions([parsed!]);
      // Some types legitimately error under empty mocks ("no active topic
      // matching …"). What must NEVER happen is the default: branch firing.
      for (const err of result.errors) {
        expect(err).not.toContain('unknown action type');
      }
    },
  );

  it.each(ALL_ACTION_TYPES)('deriveThreadItems parses "%s" back from a persisted call', (type) => {
    const parsed = parseProposalAction(SAMPLES[type]);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe(type);
  });

  it.each(ALL_ACTION_TYPES)('ProposalCard renders a labelled row for "%s"', (type) => {
    const parsed = parseProposalAction(SAMPLES[type]);
    const row = actionToRow(parsed!);
    // `articleFeedback.proposalTitle` is the card HEADER key, reused by the
    // exhaustiveness guard — a row wearing it is an unhandled type.
    expect(row.labelKey).not.toBe('articleFeedback.proposalTitle');
  });
});

describe('structured filters survive the persisted round-trip', () => {
  it('parseProposalAction keeps a valid kind+value pair', () => {
    const parsed = parseProposalAction(SAMPLES.add_suppression) as {
      suppressionKind?: string;
      suppressionValue?: string;
    };
    expect(parsed.suppressionKind).toBe('category');
    expect(parsed.suppressionValue).toBe('Entertainment');
  });

  it('drops an unknown kind, and a kind with no value (both ⇒ keyword)', () => {
    const bogus = parseProposalAction({
      type: 'add_suppression',
      suppressionPattern: 'p',
      suppressionKind: 'sentiment',
      suppressionValue: 'negative',
    }) as { suppressionKind?: string; suppressionValue?: string };
    expect(bogus.suppressionKind).toBeUndefined();
    expect(bogus.suppressionValue).toBeUndefined();

    const valueless = parseProposalAction({
      type: 'add_suppression',
      suppressionPattern: 'p',
      suppressionKind: 'category',
      suppressionValue: '   ',
    }) as { suppressionKind?: string };
    expect(valueless.suppressionKind).toBeUndefined();
  });

  it('executeProposalActions forwards kind + value to the executor', async () => {
    const { applyPersonaAction } = require('@/lib/database/services/persona-action-executor');
    (applyPersonaAction as jest.Mock).mockClear();
    await executeProposalActions([parseProposalAction(SAMPLES.add_suppression)!]);
    expect(applyPersonaAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'add_suppression',
        suppressionKind: 'category',
        suppressionValue: 'Entertainment',
      }),
      'user',
    );
  });

  it('executeProposalActions routes retire_suppression by id', async () => {
    const { applyPersonaAction } = require('@/lib/database/services/persona-action-executor');
    (applyPersonaAction as jest.Mock).mockClear();
    const result = await executeProposalActions([
      parseProposalAction(SAMPLES.retire_suppression)!,
    ]);
    expect(applyPersonaAction).toHaveBeenCalledWith(
      { action_type: 'retire_suppression', suppressionId: 'sup-1' },
      'user',
    );
    expect(result.applied).toBe(1);
    expect(result.errors).toEqual([]);
  });
});
