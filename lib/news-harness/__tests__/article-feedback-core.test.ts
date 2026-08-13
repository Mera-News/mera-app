// article-feedback-core.test.ts — unit tests for the RN-free brain in
// lib/news-harness/article-feedback/agent-core.ts. No mocks: every export is a
// pure function of its plain inputs.

import {
  buildArticleFeedbackSystemPrompt,
  buildFeedbackContext,
  decideProposeChanges,
  decideProposeTrack,
  getArticleFeedbackToolDefinitions,
  selectActiveFiltersForContext,
} from '../article-feedback/agent-core';
import { estimateTokens } from '@/lib/llm/tokens';
import { SUPPRESSION_KINDS } from '../core/types';
import type {
  ActiveSuppressionView,
  Fact,
  SuggestionFeedbackContext,
  StagedProposal,
  TrackFeedbackSubject,
} from '../core/types';

/** not-interested P4a: named ceiling for the XML-path system prompt, so the
 *  budget assertion states a number instead of "fits". Measured 2080, ceiling
 *  2200.
 *
 *  RAISED to 2360 (measured 2241) for the two scope-precision rules: the place
 *  anchor and the keep-the-capitals case rule. Both are deliberate spend, not
 *  drift — the case rule is what makes the server's geo gate work at all (it
 *  detects a place by its uppercase first letter, so the previous "plain
 *  lowercase retrieval query" mandate made every followed topic un-geo-
 *  filterable). Re-measure and restate BOTH numbers if you edit the prompt; do
 *  not buy headroom by trimming those two rules. */
const ARTICLE_SYSTEM_PROMPT_TOKEN_CEILING = 2360;

/** Fixed injected clock — 2026-03-04T05:06:07Z. Pinned so every assertion over
 *  the rendered context stays deterministic (the builder never reads Date.now). */
const NOW_MS = Date.UTC(2026, 2, 4, 5, 6, 7);

function fact(id: string, statement: string, topics?: string[]): Fact {
  return {
    id,
    statement,
    metadata: topics ? { topics } : undefined,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function scoredContext(overrides: Partial<SuggestionFeedbackContext['suggestion']> = {}): SuggestionFeedbackContext {
  return {
    suggestion: {
      title_en: 'EU passes AI Act',
      title_original: null,
      description_en: 'The European Union has approved sweeping AI regulation.',
      publication_name: 'Euronews',
      isScored: true,
      relevance: 0.62,
      reason: 'Relates to your AI engineering work.',
      ...overrides,
    },
    matchedTopicTexts: ['EU AI regulation', 'AI policy'],
    linkedFacts: [{ id: 'f1', statement: 'Senior ML engineer at DeepMind' }],
  };
}

describe('buildArticleFeedbackSystemPrompt', () => {
  it('includes the XML tool-call format block only when needsToolFormat', () => {
    const withFormat = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    const withoutFormat = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(withFormat).toContain('<tool_call>');
    expect(withFormat).toContain('proposeChanges');
    expect(withoutFormat).not.toContain('<tool_call>');
  });

  it('states capability boundaries and the feature-request escape hatch', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(prompt).toContain('CANNOT');
    expect(prompt).toContain('submit_feature_request');
  });

  it('carries the limited-article-access disclosure', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(prompt).toContain('NEVER the full article text');
    expect(prompt).toContain('source of truth');
  });

  it('documents retire_topic, choose_one, and the suppression-strength scale', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    expect(prompt).toContain('retire_topic');
    expect(prompt).toContain('choose_one');
    expect(prompt).toContain('0.9');
    expect(prompt).toContain('0.5');
  });

  // not-interested P4a — contract delta: the chars-proxy (`prompt.length <
  // 8000`) is replaced by the real estimator the runtime budgets against
  // (lib/llm/tokens::estimateTokens, mirrored inside agent-core). MEASURED
  // 2026-07-29: 2080 tokens for the XML path with the D9 suppression wording;
  // the ceiling leaves ~120 tokens of drift room before it fails.
  it('stays under the measured system-prompt token ceiling', () => {
    // The XML-format path (local) is the larger of the two.
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    expect(estimateTokens(prompt)).toBeLessThan(ARTICLE_SYSTEM_PROMPT_TOKEN_CEILING);
  });

  // pivot P8c — THE REASON THE CLAIM PICKER IS CLOUD-ONLY, pinned so it stays
  // that way. Its rules are ~1,200 MEASURED tokens (85% separability; not
  // shortenable without re-running the replay), and the local path's whole input
  // budget is ~3,072. Splicing them into the LOCAL prompt took system + a
  // saturated context from 2,740 to 4,145 — i.e. straight through the budget the
  // test below exists to defend, silently truncating a surface that was already
  // living inside it.
  it('adds the claim-picker section on CLOUD only, and not one byte on LOCAL', () => {
    const local = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    const cloudOff = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    const cloudOn = buildArticleFeedbackSystemPrompt({
      needsToolFormat: false,
      languageName: 'English',
      factCheck: true,
    });

    expect(local).not.toContain('proposeFactCheck');
    expect(cloudOff).not.toContain('proposeFactCheck');
    expect(cloudOn).toContain('proposeFactCheck');
    // The cloud path enforces no hard input budget (see
    // CLOUD_HISTORY_BUDGET_TOKENS' note), but latency and cost are real: this is
    // the policy ceiling for the biggest prompt this surface can build.
    expect(estimateTokens(cloudOn)).toBeLessThan(3200);
  });

  // The LOCAL flag must not be able to smuggle the section in through the XML
  // tool-format block, which is the one part of the prompt only that path sees.
  // The 85%-separability measurement was established against a ~900-char
  // summary. Moving the prompt text verbatim while the context still truncated
  // the description at 160 would carry the words and not the result — every rule
  // that measurement bought is a rule about what the model READS.
  it('widens the article description for the claim picker, and only for it', () => {
    const long = `${'A'.repeat(880)} END`;
    const ctx = { ...scoredContext() };
    ctx.suggestion = { ...ctx.suggestion, description_en: long };

    const withFactCheck = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: ctx,
      proposal: null,
      factCheck: true,
    });
    const without = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: ctx,
      proposal: null,
    });

    expect(withFactCheck).toContain('END');
    // The LOCAL path is byte-identical to what it renders today: ~185 extra
    // tokens against a ~3,072 budget is exactly the trade the cloud/local split
    // exists to avoid.
    expect(without).not.toContain('END');
    expect(without.length).toBeLessThan(withFactCheck.length);
  });

  it('never lists proposeFactCheck in the local XML tool format', () => {
    const localWithFlag = buildArticleFeedbackSystemPrompt({
      needsToolFormat: true,
      languageName: 'English',
      factCheck: false,
    });
    expect(localWithFlag).toContain('- proposeTrack:');
    expect(localWithFlag).not.toContain('- proposeFactCheck:');
  });

  // not-interested P4a — new: the YOUR FILTERS block is the only unbounded
  // addition to this surface's context, so pin system + a saturated context
  // (full article, 12 long facts, filters at MAX_ACTIVE_FILTERS) against the
  // on-device input budget. MEASURED 2026-07-29: 2080 + 660 = 2740.
  it('system + a filter-saturated context fits the ~3072-token input budget', () => {
    const system = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    const context = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: Array.from({ length: 12 }, (_, i) => fact(`f${i}`, 'A'.repeat(199), ['alpha', 'beta', 'gamma'])),
      context: scoredContext(),
      proposal: null,
      activeSuppressions: Array.from({ length: 12 }, (_, i) => ({
        id: `abcdefgh1234567${i % 10}`,
        pattern: 'celebrity gossip and reality television',
        kind: 'keyword' as const,
      })),
    });
    expect(estimateTokens(system) + estimateTokens(context)).toBeLessThan(3072);
  });

  it('documents the verbatim-value rule and retire_suppression', () => {
    // not-interested P4a — contract delta: D9 wording must survive edits. A
    // structured filter matches by EXACT equality, so an invented value is a
    // filter that silently never fires; the prompt must say so in both paths.
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
    expect(prompt).toContain('COPY THE VALUE VERBATIM');
    expect(prompt).toContain('matches NOTHING');
    expect(prompt).toContain('retire_suppression');
    expect(prompt).toContain('YOUR FILTERS');
    // The XML tool-format block (local path) repeats the rule — the JSON-Schema
    // descriptions the cloud path reads are NOT sent on that path.
    expect(prompt).toContain('copy VERBATIM from <context>');
  });

  it('forbids dated track scopes and points at the <context> dates', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English' });
    expect(prompt).toContain('NEVER name an already-ended year, season or edition');
    expect(prompt).toContain('Today / Published dates in <context>');
    expect(prompt).toContain('UNDATED');
    // The rule is imperative only — no clock value here, so the per-session
    // system-prompt cache in ArticleFeedbackAgent stays correct.
    expect(prompt).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  // Precision rules. These pull in the OPPOSITE direction from the undated rule
  // above, so they are pinned right beside it: an edit that generalises the
  // scope to keep it "matchable" must not take the place anchor or the capitals
  // with it.
  it('keeps the place anchor in the search for a single localised incident', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false });
    expect(prompt).toContain('ONE incident in ONE place');
    expect(prompt).toContain('venue, street, building or town name');
    expect(prompt).toContain('A place is not a date');
  });

  it('mandates sentence case with capitals, and never lowercase, for the search', () => {
    // The server's geo gate detects a place by its uppercase first letter, so a
    // lowercase-mandated query is silently un-geo-filterable. Do not "tidy" the
    // prompt back to "a plain lowercase retrieval query".
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: true });
    expect(prompt).toContain('KEEP THE CAPITALS');
    expect(prompt).toContain('recognises a place by its capital letter');
    expect(prompt).not.toMatch(/plain lowercase|lowercase (search|retrieval) query/);
    // The worked examples have to obey the rule or the model copies their case.
    expect(prompt).toContain('"search": "Russia Ukraine war"');
  });

  it('keeps the case rule on the CLOUD path too (JSON-Schema tool descriptions)', () => {
    // The system prompt above is the LOCAL path's carrier. The cloud path reads
    // the tool schema instead, so the rule has to be stated in both or half the
    // installed base keeps emitting lowercase.
    const [, track] = getArticleFeedbackToolDefinitions();
    const search = (
      track.function.parameters.properties.options as {
        items: { properties: { search: { description: string } } };
      }
    ).items.properties.search.description;
    expect(search).toContain('KEEP their capitals');
    expect(search).not.toMatch(/lowercase/);
  });

  it('pins the language name when provided', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'French' });
    expect(prompt).toContain('**French**');
  });

  it('falls back to a match-the-user language rule when no language given', () => {
    const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false });
    expect(prompt).toContain("Match the user's language");
  });

  // pivot P6 (F4): the old text taught the model to refuse the moment a
  // question went past the metadata ("say plainly you don't have the full
  // article ... recommend reading it") with no mention it could search. That
  // refusal is the bug the user reported ("it says I don't have visibility
  // into the article") even WITH the toggle on, because the tool was never
  // declared on this surface at all (see the webSearch gate tests above) — and
  // even once declared, an unchanged prompt would still teach refusal first.
  describe('webSearch prose gate', () => {
    it('is byte-identical to the pre-existing text when webSearch is omitted (default false)', () => {
      const withParam = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English', webSearch: false });
      const withoutParam = buildArticleFeedbackSystemPrompt({ needsToolFormat: true, languageName: 'English' });
      expect(withParam).toBe(withoutParam);
      expect(withoutParam).not.toContain('WEB SEARCH');
      expect(withoutParam).not.toContain('webSearch');
    });

    it('still carries the honest metadata-only disclosure when webSearch is on', () => {
      const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English', webSearch: true });
      expect(prompt).toContain('NEVER the full article text');
    });

    it('teaches searching instead of refusing when webSearch is on', () => {
      const off = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English', webSearch: false });
      const on = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, languageName: 'English', webSearch: true });
      expect(off).not.toContain('WEB SEARCH');
      expect(on).toContain('WEB SEARCH');
      expect(on).toContain('webSearch');
      expect(on).toContain('naming the publications');
    });
  });
});

describe('buildFeedbackContext', () => {
  it('renders ARTICLE, relevance status, topics, and producing facts', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [fact('f1', 'Senior ML engineer at DeepMind', ['AI', 'ML', 'startups', 'extra'])],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('EU passes AI Act');
    expect(ctx).toContain('Publication: Euronews');
    expect(ctx).toContain('Relevance score: 6.2/10');
    expect(ctx).toContain('Reason given: "Relates to your AI engineering work."');
    expect(ctx).toContain('EU AI regulation');
    expect(ctx).toContain('[f1] Senior ML engineer at DeepMind');
    expect(ctx).toContain('## ALL YOUR FACTS');
    // topics preview capped at 3
    expect(ctx).toContain('(topics: AI, ML, startups)');
    expect(ctx).not.toContain('extra');
  });

  it('falls back to the store title and the "not a suggestion" status when context is null', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: null,
      fallbackTitle: 'A cluster article',
      proposal: null,
    });
    expect(ctx).toContain('A cluster article');
    expect(ctx).toContain('This article was NOT one of your personalized suggestions.');
    // No suggestion → matched topics / producing facts render "None."
    expect(ctx).toContain('## MATCHED TOPICS\nNone.');
    expect(ctx).toContain('## FACTS THAT PRODUCED THEM\nNone.');
  });

  it('marks an unscored suggestion (not yet scored)', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext({ isScored: false, relevance: 0, reason: '' }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('scoring has not finished');
  });

  it('omits the reason clause when a scored suggestion has no reason', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext({ reason: '' }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('Relevance score: 6.2/10.');
    expect(ctx).not.toContain('Reason given');
  });

  it('injects the USER VERDICT block (with tapped options) on a Feed handoff', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
      verdict: 'dislike',
      tappedOptions: ['Not a good suggestion', 'Wrong topic'],
    });
    expect(ctx).toContain('## USER VERDICT');
    expect(ctx).toContain('DISLIKED');
    expect(ctx).toContain('TAPPED OPTIONS: Not a good suggestion → Wrong topic');
  });

  it('omits the USER VERDICT block when no verdict is present', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).not.toContain('## USER VERDICT');
  });

  it('injects the PENDING PROPOSAL block when a proposal is staged', () => {
    const proposal: StagedProposal = {
      id: 'p1',
      explanation: 'You wanted less AI news.',
      expectedEffects: 'Fewer AI stories.',
      actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
    };
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal,
    });
    expect(ctx).toContain('## PENDING PROPOSAL');
    expect(ctx).toContain('You wanted less AI news.');
    expect(ctx).toContain('remove topics from [f1]: AI');
    expect(ctx).toContain('applyProposal');
  });

  it('tells the model to have the user TAP — not applyProposal — on a chooseOne card', () => {
    // G1: applyProposal REFUSES a single-select proposal, so the context must
    // not order the model to call it (that turn would dead-end).
    const proposal: StagedProposal = {
      id: 'p-choose',
      explanation: 'Pick how far to go.',
      expectedEffects: 'One of these.',
      chooseOne: true,
      actions: [
        { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
        { type: 'retire_topic', topicText: 'cricket' },
      ],
    };
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal,
    });
    expect(ctx).toContain('## PENDING PROPOSAL');
    expect(ctx).toContain('TAP');
    expect(ctx).toContain('do NOT call applyProposal');
    // cancelProposal stays available — declining must still work.
    expect(ctx).toContain('cancelProposal');
  });

  it('describes every action variant in the PENDING PROPOSAL block', () => {
    const proposal: StagedProposal = {
      id: 'p2',
      explanation: 'Mixed changes.',
      expectedEffects: 'Various.',
      actions: [
        { type: 'add_fact', statement: 'Likes AI' },
        { type: 'update_fact', fact_id: 'f1', new_statement: 'Staff engineer' },
        { type: 'delete_fact', fact_id: 'f2' },
        { type: 'add_topics', fact_id: 'f1', topics: ['ML'] },
        { type: 'remove_topics', fact_id: 'f1', topics: ['crypto'] },
        { type: 'submit_feature_request', title: 'Mute publications', summary: 'Mute a source.' },
        { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
        { type: 'add_negative_topic', topicText: 'Delhi crime' },
        { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
        { type: 'add_suppression', suppressionPattern: 'lottery results' },
        { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
        { type: 'retire_topic', topicText: 'cricket' },
      ],
    };
    const ctx = buildFeedbackContext({ nowMs: NOW_MS, facts: [], context: null, fallbackTitle: 'T', proposal });
    expect(ctx).toContain('retire topic "cricket"');
    expect(ctx).toContain('add fact "Likes AI"');
    expect(ctx).toContain('update [f1] → "Staff engineer"');
    expect(ctx).toContain('delete [f2]');
    expect(ctx).toContain('add topics to [f1]: ML');
    expect(ctx).toContain('remove topics from [f1]: crypto');
    expect(ctx).toContain('send feature request "Mute publications" to the Mera team');
    expect(ctx).toContain('show less of "cricket"');
    expect(ctx).toContain('down-rank "Delhi crime"');
    expect(ctx).toContain('mute publication "Times of India"');
    expect(ctx).toContain('suppress "lottery results"');
    expect(ctx).toContain('pin topic "AI policy"');
  });

  it('drops the ALL-FACTS block when the context exceeds the token budget', () => {
    const bigStatement = 'x'.repeat(115);
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact(`f${i}`, bigStatement, ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]),
    );
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts,
      context: scoredContext({ isScored: true }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).not.toContain('## ALL YOUR FACTS');
    // essential blocks survive
    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('## SUGGESTION STATUS');
  });

  it('renders the ARTICLE category + entities lines when present', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: {
        suggestion: scoredContext().suggestion,
        matchedTopicTexts: [],
        linkedFacts: [],
        category: 'Politics',
        entities: ['Narendra Modi', 'BJP', 'Lok Sabha', 'a', 'b', 'c', 'd', 'e', 'DROPPED'],
      },
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('Category: Politics');
    expect(ctx).toContain('Entities: Narendra Modi, BJP, Lok Sabha');
    // capped at 8 entities
    expect(ctx).not.toContain('DROPPED');
  });

  it('renders a RELATED COVERAGE block (≤5 titles) when provided', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
      relatedCoverage: ['Protest spreads', 'Exam board responds', 'a', 'b', 'c', 'SIXTH'],
    });
    expect(ctx).toContain('## RELATED COVERAGE');
    expect(ctx).toContain('- Protest spreads');
    expect(ctx).toContain('- Exam board responds');
    expect(ctx).not.toContain('SIXTH');
  });

  it('omits the RELATED COVERAGE block when empty', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
      relatedCoverage: [],
    });
    expect(ctx).not.toContain('## RELATED COVERAGE');
  });

  // --- Injected date anchor (stops proposeTrack proposing a finished season) ---

  it('renders the injected nowMs as a Today line (UTC, no clock read)', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('Today: 2026-03-04');
  });

  it('is deterministic for a fixed nowMs and varies only with it', () => {
    const build = (nowMs: number) =>
      buildFeedbackContext({
        nowMs,
        facts: [fact('f1', 'Senior ML engineer at DeepMind', ['AI'])],
        context: scoredContext(),
        fallbackTitle: undefined,
        proposal: null,
        relatedCoverage: ['Hungarian GP practice report'],
      });
    // Same injected date → byte-identical prompt, twice.
    expect(build(NOW_MS)).toBe(build(NOW_MS));
    const later = build(Date.UTC(2027, 6, 15));
    expect(later).not.toBe(build(NOW_MS));
    expect(later).toContain('Today: 2027-07-15');
  });

  it('renders the article publication date when the caller supplies one', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      articlePubDate: '2026-02-27T11:30:00.000Z',
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('## ARTICLE');
    expect(ctx).toContain('Published: 2026-02-27');
  });

  it('renders the publication date on the no-suggestion fallback ARTICLE block too', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      articlePubDate: '2026-02-27T11:30:00.000Z',
      facts: [],
      context: null,
      fallbackTitle: 'A cluster article',
      proposal: null,
    });
    expect(ctx).toContain('Published: 2026-02-27');
  });

  it('omits the Published line when the pub date is absent or unparseable', () => {
    const base = {
      nowMs: NOW_MS,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    };
    expect(buildFeedbackContext(base)).not.toContain('Published:');
    expect(buildFeedbackContext({ ...base, articlePubDate: null })).not.toContain('Published:');
    expect(buildFeedbackContext({ ...base, articlePubDate: '   ' })).not.toContain('Published:');
    expect(buildFeedbackContext({ ...base, articlePubDate: 'not a date' })).not.toContain('Published:');
  });

  it('degrades to "unknown" rather than throwing on a non-finite nowMs', () => {
    const ctx = buildFeedbackContext({
      nowMs: Number.NaN,
      facts: [],
      context: scoredContext(),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('Today: unknown');
  });

  it('keeps the Today line when the ALL-FACTS block is dropped for budget', () => {
    const bigStatement = 'x'.repeat(115);
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact(`f${i}`, bigStatement, ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]),
    );
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts,
      context: scoredContext({ isScored: true }),
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).not.toContain('## ALL YOUR FACTS');
    expect(ctx).toContain('Today: 2026-03-04');
  });

  it('caps matched topics and producing facts to their limits', () => {
    const manyTopics = Array.from({ length: 15 }, (_, i) => `topic-${i}`);
    const manyFacts = Array.from({ length: 8 }, (_, i) => ({ id: `lf${i}`, statement: `producing ${i}` }));
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: {
        suggestion: scoredContext().suggestion,
        matchedTopicTexts: manyTopics,
        linkedFacts: manyFacts,
      },
      fallbackTitle: undefined,
      proposal: null,
    });
    expect(ctx).toContain('topic-9'); // 10th matched topic (index 9) present
    expect(ctx).not.toContain('topic-10'); // capped at 10
    expect(ctx).toContain('[lf4] producing 4'); // 5th producing fact present
    expect(ctx).not.toContain('[lf5] producing 5'); // capped at 5
  });
});

describe('getArticleFeedbackToolDefinitions', () => {
  // pivot P8c — `proposeFactCheck` joined this surface (the Quick fact check
  // chip and the article tick both send into THIS thread), CLOUD-only: it costs
  // ~1,200 tokens of measured prompt text that the local path's ~3,072-token
  // input budget has no room for, and the check it proposes needs the cloud
  // anyway. The LOCAL list is therefore the four it always was.
  it('exposes the proposal + follow tools in order', () => {
    expect(getArticleFeedbackToolDefinitions('LOCAL').map((t) => t.function.name)).toEqual([
      'proposeChanges',
      'proposeTrack',
      'applyProposal',
      'cancelProposal',
    ]);
    expect(getArticleFeedbackToolDefinitions().map((t) => t.function.name)).toEqual([
      'proposeChanges',
      'proposeTrack',
      'applyProposal',
      'cancelProposal',
      'proposeFactCheck',
    ]);
  });

  it('declares the proposeChanges required params and action enum', () => {
    const propose = getArticleFeedbackToolDefinitions()[0];
    expect(propose.function.parameters.required).toEqual(['explanation', 'expected_effects', 'actions']);
    const actionType = (propose.function.parameters.properties.actions as {
      items: { properties: { type: { enum: string[] } } };
    }).items.properties.type.enum;
    expect(actionType).toEqual([
      'add_fact',
      'update_fact',
      'delete_fact',
      'add_topics',
      'remove_topics',
      'submit_feature_request',
      'set_topic_weight',
      'add_negative_topic',
      'set_publication_pref',
      'add_suppression',
      // not-interested P4a — contract delta: removing a filter is a first-class
      // chat action (D6), staged and confirmed like any other proposal.
      'retire_suppression',
      'set_high_priority',
      'retire_topic',
    ]);
  });

  it('declares the Wave-9 rails params on the proposeChanges action schema', () => {
    const propose = getArticleFeedbackToolDefinitions()[0];
    const props = (propose.function.parameters.properties.actions as {
      items: { properties: Record<string, unknown> };
    }).items.properties;
    // not-interested P4a — contract delta: suppressionKind / suppressionValue
    // (structured filters) and suppressionId (retire) join the action schema.
    // A schema field the sanitizer drops is worse than no field, so the
    // decideProposeChanges specs below cover every one of them.
    for (const key of ['topicText', 'delta', 'weight', 'publicationId', 'publicationPref', 'suppressionPattern', 'suppressionKeywords', 'suppressionStrength', 'suppressionKind', 'suppressionValue', 'suppressionId', 'highPriority']) {
      expect(props[key]).toBeDefined();
    }
    expect((props.publicationPref as { enum: string[] }).enum).toEqual(['boost', 'deprioritize', 'mute']);
    // The kind enum mirrors SUPPRESSION_KINDS verbatim (order is load-bearing —
    // it is the same array the DB model persists against).
    expect((props.suppressionKind as { enum: string[] }).enum).toEqual([...SUPPRESSION_KINDS]);
  });

  it('declares the choose_one flag on proposeChanges and options[] on proposeTrack', () => {
    const [propose, track] = getArticleFeedbackToolDefinitions();
    expect(propose.function.parameters.properties.choose_one).toBeDefined();
    expect((propose.function.parameters.properties.choose_one as { type: string }).type).toBe('boolean');
    expect(track.function.parameters.properties.options).toBeDefined();
    expect((track.function.parameters.properties.options as { type: string }).type).toBe('array');
  });

  // pivot P6 (F4): the article surface previously never declared `webSearch`
  // at all, so the "Web search in chat" toggle was inert here regardless of
  // its value. These pin BOTH directions of the gate — the toggle must be
  // observable, not merely claimed.
  describe('webSearch gate', () => {
    it('omits webSearch by default (no args — matches every pre-existing call site)', () => {
      const names = getArticleFeedbackToolDefinitions().map((t) => t.function.name);
      expect(names).not.toContain('webSearch');
    });

    it('omits webSearch in CLOUD when the toggle is off', () => {
      const names = getArticleFeedbackToolDefinitions('CLOUD', false).map((t) => t.function.name);
      expect(names).not.toContain('webSearch');
    });

    it('declares webSearch in CLOUD when the toggle is on', () => {
      const names = getArticleFeedbackToolDefinitions('CLOUD', true).map((t) => t.function.name);
      expect(names).toContain('webSearch');
      const tool = getArticleFeedbackToolDefinitions('CLOUD', true).find((t) => t.function.name === 'webSearch')!;
      expect(tool.function.parameters.properties.query).toBeDefined();
    });

    it('never declares webSearch in LOCAL, even with the toggle on — the one-shot path cannot read a tool result', () => {
      const names = getArticleFeedbackToolDefinitions('LOCAL', true).map((t) => t.function.name);
      expect(names).not.toContain('webSearch');
    });

    it('leaves the other tools and their order untouched when webSearch is appended', () => {
      const names = getArticleFeedbackToolDefinitions('CLOUD', true).map((t) => t.function.name);
      expect(names).toEqual([
        'proposeChanges',
        'proposeTrack',
        'applyProposal',
        'cancelProposal',
        'proposeFactCheck',
        'webSearch',
      ]);
    });
  });
});

describe('decideProposeChanges', () => {
  it('stages a valid proposal and returns it as a side effect', () => {
    const result = decideProposeChanges(
      {
        explanation: 'You wanted less AI news.',
        expected_effects: 'Fewer AI stories.',
        actions: [{ type: 'remove_topics', fact_id: 'f1', topics: ['AI'] }],
      },
      new Set(['f1']),
    );
    expect(result.result).toEqual({
      staged: true,
      actionCount: 1,
      proposalId: result.sideEffects?.proposal?.id,
    });
    expect(result.sideEffects?.proposal?.actions).toHaveLength(1);
    expect(result.sideEffects?.proposal?.id).toMatch(/^proposal-/);
  });

  it('echoes the staged proposal id in the result', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.proposalId).toBeDefined();
    expect(result.result.proposalId).toBe(result.sideEffects?.proposal?.id);
  });

  it('validates and stages a submit_feature_request action (no fact_id needed)', () => {
    const result = decideProposeChanges(
      {
        explanation: "I'll send this suggestion to the Mera team.",
        expected_effects: "The team will consider it — this won't change your feed today.",
        actions: [
          { type: 'submit_feature_request', title: 'Mute a publication', summary: 'Allow users to mute a publication so its articles stop appearing.' },
        ],
      },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({
      type: 'submit_feature_request',
      title: 'Mute a publication',
      summary: 'Allow users to mute a publication so its articles stop appearing.',
    });
  });

  it('rejects an action referencing an unknown fact_id (no side effect)', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'delete_fact', fact_id: 'ghost' }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('ghost');
    expect(result.sideEffects).toBeUndefined();
  });

  it('rejects a missing explanation', () => {
    const result = decideProposeChanges(
      { expected_effects: 'y', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.error).toContain('explanation');
  });

  it('rejects a missing expected_effects', () => {
    const result = decideProposeChanges(
      { explanation: 'x', actions: [{ type: 'add_fact', statement: 'Likes AI' }] },
      new Set(),
    );
    expect(result.result.error).toContain('expected_effects');
  });

  it('rejects an empty actions array', () => {
    const result = decideProposeChanges({ explanation: 'x', expected_effects: 'y', actions: [] }, new Set());
    expect(result.result.error).toContain('actions');
  });

  it('rejects a submit_feature_request with an over-long title', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'z'.repeat(81), summary: 'ok' }] },
      new Set(),
    );
    expect(result.result.error).toContain('title');
  });

  it('rejects a submit_feature_request with a missing summary', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'Mute', summary: '' }] },
      new Set(),
    );
    expect(result.result.error).toContain('summary');
  });

  it('rejects a submit_feature_request with an over-long summary', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'submit_feature_request', title: 'Mute', summary: 's'.repeat(501) }] },
      new Set(),
    );
    expect(result.result.error).toContain('summary');
  });

  it('stages a valid update_fact, delete_fact, and add_topics', () => {
    const result = decideProposeChanges(
      {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'update_fact', fact_id: 'f1', new_statement: 'Now a staff engineer' },
          { type: 'delete_fact', fact_id: 'f2' },
          { type: 'add_topics', fact_id: 'f1', topics: ['ML', ' ', 'AI'] },
        ],
      },
      new Set(['f1', 'f2']),
    );
    expect(result.result.actionCount).toBe(3);
    const actions = result.sideEffects?.proposal?.actions;
    expect(actions?.[0]).toEqual({ type: 'update_fact', fact_id: 'f1', new_statement: 'Now a staff engineer' });
    expect(actions?.[1]).toEqual({ type: 'delete_fact', fact_id: 'f2' });
    // blank topic entries are stripped
    expect(actions?.[2]).toEqual({ type: 'add_topics', fact_id: 'f1', topics: ['ML', 'AI'] });
  });

  it('rejects update_fact with an empty new_statement', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'update_fact', fact_id: 'f1', new_statement: '  ' }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('new_statement');
  });

  it('rejects add_topics with an empty topics array', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_topics', fact_id: 'f1', topics: [] }] },
      new Set(['f1']),
    );
    expect(result.result.error).toContain('topics');
  });

  it('rejects add_fact with an empty statement', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_fact', statement: '   ' }] },
      new Set(),
    );
    expect(result.result.error).toContain('statement');
  });

  it('maps each Wave-9 rails action to its ProposalAction shape', () => {
    const result = decideProposeChanges(
      {
        explanation: 'x',
        expected_effects: 'y',
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'add_negative_topic', topicText: 'Delhi crime' },
          { type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' },
          { type: 'add_suppression', suppressionPattern: 'lottery results' },
          { type: 'set_high_priority', topicText: 'AI policy', highPriority: true },
        ],
      },
      new Set(),
    );
    const actions = result.sideEffects?.proposal?.actions;
    expect(actions).toHaveLength(5);
    expect(actions?.[0]).toEqual({ type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 });
    expect(actions?.[1]).toEqual({ type: 'add_negative_topic', topicText: 'Delhi crime' });
    expect(actions?.[2]).toEqual({ type: 'set_publication_pref', publicationId: 'Times of India', publicationPref: 'mute' });
    expect(actions?.[3]).toEqual({ type: 'add_suppression', suppressionPattern: 'lottery results' });
    expect(actions?.[4]).toEqual({ type: 'set_high_priority', topicText: 'AI policy', highPriority: true });
  });

  it('validates a retire_topic action', () => {
    const ok = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'retire_topic', topicText: 'cricket' }] },
      new Set(),
    );
    expect(ok.sideEffects?.proposal?.actions[0]).toEqual({ type: 'retire_topic', topicText: 'cricket' });
    const bad = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'retire_topic', topicText: '  ' }] },
      new Set(),
    );
    expect(bad.result.error).toContain('topicText');
  });

  it('marks the proposal chooseOne when choose_one is set with ≥2 alternatives', () => {
    const result = decideProposeChanges(
      {
        explanation: 'Less of this?',
        expected_effects: 'Pick one.',
        choose_one: true,
        actions: [
          { type: 'set_topic_weight', topicText: 'cricket', delta: -0.3 },
          { type: 'retire_topic', topicText: 'cricket' },
        ],
      },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.chooseOne).toBe(true);
    expect(result.result.chooseOne).toBe(true);
  });

  it('does NOT mark chooseOne when choose_one is set but only ONE action', () => {
    const result = decideProposeChanges(
      {
        explanation: 'x',
        expected_effects: 'y',
        choose_one: true,
        actions: [{ type: 'retire_topic', topicText: 'cricket' }],
      },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.chooseOne).toBeUndefined();
    expect(result.result.chooseOne).toBeUndefined();
  });

  it('clamps an over-large set_topic_weight delta to the gentle-nudge bound', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: 'cricket', delta: -5 }] },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({ type: 'set_topic_weight', topicText: 'cricket', delta: -0.5 });
  });

  it('carries an explicit add_negative_topic weight when provided', () => {
    const result = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_negative_topic', topicText: 'crypto', weight: -0.8 }] },
      new Set(),
    );
    expect(result.sideEffects?.proposal?.actions[0]).toEqual({ type: 'add_negative_topic', topicText: 'crypto', weight: -0.8 });
  });

  it('rejects invalid Wave-9 rails actions', () => {
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: '', delta: -0.3 }] },
        new Set(),
      ).result.error,
    ).toContain('topicText');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_topic_weight', topicText: 'cricket', delta: 0 }] },
        new Set(),
      ).result.error,
    ).toContain('delta');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_publication_pref', publicationId: 'X', publicationPref: 'ban' }] },
        new Set(),
      ).result.error,
    ).toContain('publicationPref');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'add_suppression', suppressionPattern: '  ' }] },
        new Set(),
      ).result.error,
    ).toContain('suppressionPattern');
    expect(
      decideProposeChanges(
        { explanation: 'x', expected_effects: 'y', actions: [{ type: 'set_high_priority', topicText: 'AI', highPriority: 'yes' }] },
        new Set(),
      ).result.error,
    ).toContain('highPriority');
  });

  it('rejects a non-object action and an unknown action type', () => {
    const nonObject = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [42] },
      new Set(),
    );
    expect(nonObject.result.error).toContain('object');

    const badType = decideProposeChanges(
      { explanation: 'x', expected_effects: 'y', actions: [{ type: 'nuke_everything' }] },
      new Set(),
    );
    expect(badType.result.error).toContain('invalid action type');
  });
});

describe('decideProposeTrack', () => {
  const subject: TrackFeedbackSubject = {
    origin: 'suggestion',
    surface: 'detail',
    articleId: 'art-1',
    title: 'Protest escalates',
    stableClusterId: 'sc-1',
    publicationName: 'The Hindu',
  };

  it('stages a single-select proposal of track_story scope pills (label + hidden search)', () => {
    const out = decideProposeTrack(
      {
        options: [
          { label: 'Attacks on Ukraine infrastructure', search: 'russia ukraine civilian infrastructure attacks' },
          { label: 'Russia–Ukraine war', search: 'russia ukraine war' },
          { label: 'Attacks on Ukraine infrastructure', search: 'dup — deduped by label' },
        ],
      },
      subject,
    );
    const proposal = out.sideEffects?.proposal;
    expect(proposal?.chooseOne).toBe(true);
    expect(proposal?.actions).toHaveLength(2); // third deduped by (case-insensitive) label
    expect(proposal?.actions).toEqual([
      {
        type: 'track_story',
        label: 'Attacks on Ukraine infrastructure',
        searchText: 'russia ukraine civilian infrastructure attacks',
        subject,
      },
      {
        type: 'track_story',
        label: 'Russia–Ukraine war',
        searchText: 'russia ukraine war',
        subject,
      },
    ]);
    // Echoes id + subject + parsed options so deriveThreadItems rebuilds the card.
    expect(out.result.proposalId).toBe(proposal?.id);
    expect(out.result.subject).toEqual(subject);
    expect(out.result.chooseOne).toBe(true);
    expect(out.result.options).toEqual([
      { label: 'Attacks on Ukraine infrastructure', search: 'russia ukraine civilian infrastructure attacks' },
      { label: 'Russia–Ukraine war', search: 'russia ukraine war' },
    ]);
  });

  it('stages a single (non-choose-one) pill when only one option is valid', () => {
    const out = decideProposeTrack(
      { options: [{ label: 'Russia–Ukraine war', search: 'russia ukraine war' }] },
      subject,
    );
    const proposal = out.sideEffects?.proposal;
    expect(proposal?.chooseOne).toBeUndefined();
    expect(proposal?.actions).toEqual([
      {
        type: 'track_story',
        label: 'Russia–Ukraine war',
        searchText: 'russia ukraine war',
        subject,
      },
    ]);
  });

  it('tolerates a legacy `track` string as a single lone option (label === search)', () => {
    const out = decideProposeTrack({ track: 'The Sonbhadra exam protest' }, subject);
    expect(out.sideEffects?.proposal?.actions).toEqual([
      {
        type: 'track_story',
        label: 'The Sonbhadra exam protest',
        searchText: 'The Sonbhadra exam protest',
        subject,
      },
    ]);
  });

  it('errors when no valid option is provided', () => {
    const out = decideProposeTrack({ options: [{ label: '   ', search: '' }] }, subject);
    expect(out.result.error).toContain('options is required');
    expect(out.sideEffects).toBeUndefined();
  });

  it('trims overly long label + search text', () => {
    const long = 'a'.repeat(400);
    const out = decideProposeTrack({ options: [{ label: long, search: long }] }, subject);
    const action = out.sideEffects?.proposal?.actions[0] as {
      type: 'track_story';
      label: string;
      searchText: string;
    };
    expect(action.label.length).toBeLessThanOrEqual(200);
    expect(action.searchText.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// not-interested P4a — "not interested" filters in the article chat (D6 + D9)
// ---------------------------------------------------------------------------

const filter = (over: Partial<ActiveSuppressionView> = {}): ActiveSuppressionView => ({
  id: 's1',
  pattern: 'celebrity gossip',
  kind: 'keyword',
  ...over,
});

function articleContext(): SuggestionFeedbackContext {
  return {
    ...scoredContext(),
    entities: ['European Union', 'DeepMind'],
    category: 'Technology',
  };
}

describe('selectActiveFiltersForContext', () => {
  it('puts the filters matching THIS article first, then the rest in caller order', () => {
    const rows = selectActiveFiltersForContext(
      [
        filter({ id: 'a', pattern: 'football' }),
        filter({ id: 'b', kind: 'category', value: 'Technology', pattern: 'Technology' }),
        filter({ id: 'c', pattern: 'cricket' }),
      ],
      articleContext(),
    );
    expect(rows.map((r) => r.row.id)).toEqual(['b', 'a', 'c']);
    expect(rows[0].matches).toBe(true);
    expect(rows[1].matches).toBe(false);
  });

  it('matches a keyword filter as a normalized substring of title/description/entities', () => {
    const rows = selectActiveFiltersForContext(
      [filter({ id: 'k', pattern: 'DEEPMIND' })],
      articleContext(),
    );
    expect(rows[0].matches).toBe(true);
  });

  it('caps the list and drops rows without an id', () => {
    const many = Array.from({ length: 20 }, (_, i) => filter({ id: `x${i}` }));
    expect(selectActiveFiltersForContext(many, null)).toHaveLength(8);
    expect(selectActiveFiltersForContext([filter({ id: '' })], null)).toHaveLength(0);
  });
});

describe('buildFeedbackContext — YOUR FILTERS block', () => {
  it('renders id, phrase and the kind (kind omitted for the default keyword)', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      facts: [],
      context: articleContext(),
      proposal: null,
      activeSuppressions: [
        filter({ id: 'k1', pattern: 'football' }),
        filter({ id: 'c1', kind: 'category', value: 'Technology', pattern: 'Technology' }),
      ],
    });
    expect(ctx).toContain('## YOUR FILTERS');
    expect(ctx).toContain('- [k1] "football"');
    expect(ctx).toContain('- [c1] "Technology" (category) — matches this article');
  });

  it('omits the block entirely when the user has no filters', () => {
    const ctx = buildFeedbackContext({ nowMs: NOW_MS, facts: [], context: null, proposal: null });
    expect(ctx).not.toContain('YOUR FILTERS');
  });

  it('survives the over-budget trim that drops ALL YOUR FACTS', () => {
    const ctx = buildFeedbackContext({
      nowMs: NOW_MS,
      // Enough fact text to blow CONTEXT_TOKEN_BUDGET and trigger the trim
      // (statements are truncated; the per-fact topic preview is not).
      facts: Array.from({ length: 12 }, (_, i) =>
        fact(`f${i}`, 'x'.repeat(115), ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300)]),
      ),
      context: articleContext(),
      proposal: null,
      activeSuppressions: [filter({ id: 'keep-me', pattern: 'football' })],
    });
    expect(ctx).not.toContain('## ALL YOUR FACTS');
    expect(ctx).toContain('- [keep-me] "football"');
  });
});

describe('decideProposeChanges — suppression kinds (D9)', () => {
  const sanitizer: {
    article: SuggestionFeedbackContext | null;
    activeSuppressions: ActiveSuppressionView[];
  } = { article: articleContext(), activeSuppressions: [filter({ id: 's1' })] };

  function stage(action: Record<string, unknown>, ctx = sanitizer) {
    return decideProposeChanges(
      { explanation: 'e', expected_effects: 'x', actions: [action] },
      new Set<string>(),
      ctx,
    );
  }

  it('keeps a structured pair the article corroborates verbatim', () => {
    const r = stage({ type: 'add_suppression', suppressionPattern: 'tech news', suppressionKind: 'category', suppressionValue: 'Technology' });
    const a = r.sideEffects!.proposal!.actions[0] as { suppressionKind?: string; suppressionValue?: string };
    expect(a.suppressionKind).toBe('category');
    expect(a.suppressionValue).toBe('Technology');
  });

  it('corroborates case-insensitively (the runtime matcher normalizes too)', () => {
    const r = stage({ type: 'add_suppression', suppressionPattern: 'p', suppressionKind: 'entity', suppressionValue: 'deepmind' });
    expect((r.sideEffects!.proposal!.actions[0] as { suppressionKind?: string }).suppressionKind).toBe('entity');
  });

  it('DOWNGRADES an invented structured value to a keyword filter instead of staging a filter that never fires', () => {
    const r = stage({ type: 'add_suppression', suppressionPattern: 'celebrity', suppressionKind: 'category', suppressionValue: 'celebrity stuff' });
    const a = r.sideEffects!.proposal!.actions[0] as { type: string; suppressionPattern: string; suppressionKind?: string; suppressionValue?: string };
    expect(a.type).toBe('add_suppression');
    expect(a.suppressionPattern).toBe('celebrity');
    expect(a.suppressionKind).toBeUndefined();
    expect(a.suppressionValue).toBeUndefined();
  });

  it('downgrades kinds the article context cannot corroborate at all (event_type, place)', () => {
    for (const kind of ['event_type', 'place']) {
      const r = stage({ type: 'add_suppression', suppressionPattern: 'p', suppressionKind: kind, suppressionValue: 'Technology' });
      expect((r.sideEffects!.proposal!.actions[0] as { suppressionKind?: string }).suppressionKind).toBeUndefined();
    }
  });

  it('downgrades when there is no article context to corroborate against', () => {
    const r = stage(
      { type: 'add_suppression', suppressionPattern: 'p', suppressionKind: 'category', suppressionValue: 'Technology' },
      { article: null, activeSuppressions: [] },
    );
    expect((r.sideEffects!.proposal!.actions[0] as { suppressionKind?: string }).suppressionKind).toBeUndefined();
  });

  it('falls back to the structured value as the display phrase when no pattern was sent', () => {
    const r = stage({ type: 'add_suppression', suppressionKind: 'publication', suppressionValue: 'Euronews' });
    const a = r.sideEffects!.proposal!.actions[0] as { suppressionPattern: string; suppressionKind?: string };
    expect(a.suppressionPattern).toBe('Euronews');
    expect(a.suppressionKind).toBe('publication');
  });

  it('still rejects an add_suppression with neither a pattern nor a value', () => {
    expect(stage({ type: 'add_suppression' }).result.error).toContain('suppressionPattern');
  });
});

describe('decideProposeChanges — retire_suppression', () => {
  const rows = [filter({ id: 'sup-1', pattern: 'celebrity gossip' })];

  function stage(action: Record<string, unknown>, activeSuppressions = rows) {
    return decideProposeChanges(
      { explanation: 'e', expected_effects: 'x', actions: [action] },
      new Set<string>(),
      { article: null, activeSuppressions },
    );
  }

  it('stages the id AND resolves the display pattern from our own list, not the model', () => {
    const r = stage({ type: 'retire_suppression', suppressionId: 'sup-1', pattern: 'something else entirely' });
    expect(r.sideEffects!.proposal!.actions[0]).toEqual({
      type: 'retire_suppression',
      suppressionId: 'sup-1',
      pattern: 'celebrity gossip',
    });
  });

  it('rejects an id that is not in the filters the agent was shown', () => {
    expect(stage({ type: 'retire_suppression', suppressionId: 'made-up' }).result.error)
      .toContain('unknown suppressionId');
  });

  it('rejects outright when no filters were put in context', () => {
    expect(stage({ type: 'retire_suppression', suppressionId: 'sup-1' }, []).result.error)
      .toContain('unknown suppressionId');
  });

  it('rejects a missing suppressionId', () => {
    expect(stage({ type: 'retire_suppression' }).result.error).toContain('suppressionId');
  });

  it('renders in the PENDING PROPOSAL line with the resolved phrase', () => {
    const proposal = stage({ type: 'retire_suppression', suppressionId: 'sup-1' })
      .sideEffects!.proposal!;
    const ctx = buildFeedbackContext({ nowMs: NOW_MS, facts: [], context: null, proposal });
    expect(ctx).toContain('remove the filter "celebrity gossip"');
  });
});
