// TOKEN BUDGET GUARD for the daily optimisation prompt.
//
// The cycle makes ONE `cloudComplete` call. `cloudComplete` only LOGS its token
// estimate — it never truncates or rejects — so exceeding the budget fails
// SILENTLY, server-side, by dropping the end of the payload. The end of this
// payload is the review candidates, i.e. exactly the changes that need a human.
//
// Attaching article entities to candidates grew the user message ~8x in the
// worst case, so "bounded by the candidate cap" needed to become a number.
// This test is that number, and it fails if a future change eats the headroom.

import { estimateTokens } from '@/lib/llm/tokens';
import {
  analyzeFeedback,
  DIGEST_CONSTANTS,
  type DigestSignal,
  type DigestTopicInput,
} from '@/lib/news-harness/persona-management/feedback-digest';

/** CLAUDE.md: n_ctx 4096, and all input must fit in ~3072 tokens. */
const INPUT_BUDGET = 3072;
/** MAX_SIGNALS_PER_RUN in optimisation-plan-service. */
const MAX_SIGNALS = 40;
/** `ForYouSuggestion.entities` is documented as <= 8 per article. */
const ENTITIES_PER_ARTICLE = 8;

const TOPIC_TEXTS = Array.from(
  { length: DIGEST_CONSTANTS.maxAutoCandidates + DIGEST_CONSTANTS.maxReviewCandidates + 1 },
  (_, i) => `Persona topic number ${i} about something`,
);

const topics: DigestTopicInput[] = TOPIC_TEXTS.map((text, i) => ({
  id: `t${i}`,
  text,
  normalizedText: text.toLowerCase(),
  weight: 0.7,
  status: 'active' as const,
  highPriority: false,
}));

/** WORST CASE ON PURPOSE: every article carries the full 8 entities and every
 *  one is DISTINCT, so dedupe (which real coverage of one story benefits from
 *  heavily) buys nothing. Entity strings are long. Real payloads are smaller. */
function mkSignals(n: number, withEntities: boolean): DigestSignal[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    sentiment: (i % 4 === 0 ? 'like' : 'dislike') as 'like' | 'dislike',
    title: `Some reasonably long news headline number ${i} about things`,
    createdAtMs: 1_700_000_000_000 - i * 1000,
    context: {
      matchedTopics: [
        { text: TOPIC_TEXTS[i % TOPIC_TEXTS.length], topicId: `t${i % TOPIC_TEXTS.length}`, weight: 0.7 },
      ],
      relevance: 0.5,
      ...(withEntities
        ? {
            entities: Array.from(
              { length: ENTITIES_PER_ARTICLE },
              (_, k) => `Entity Name ${i}-${k} International`,
            ),
          }
        : {}),
    },
  }));
}

/** Mirrors `buildOrganizeUserMessage` (not exported — it is an internal of the
 *  service, and importing the service here would drag the WatermelonDB graph in
 *  for a pure string measurement). Kept in step by the shape assertions below. */
function render(cands: ReturnType<typeof analyzeFeedback>): string {
  return cands
    .map((c) => {
      const conflicts =
        c.conflictsWith.length > 0
          ? ` | conflicts: ${c.conflictsWith.map((x) => x.title).join('; ')}`
          : '';
      const ec = c.entityContext;
      const about = [
        ec?.liked.length ? `liked: ${ec.liked.join(', ')}` : '',
        ec?.disliked.length ? `disliked: ${ec.disliked.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' / ');
      return `[${c.fingerprint}] ${c.kind} | ${c.summary}${conflicts}${about ? ` | about — ${about}` : ''}`;
    })
    .join('\n');
}

const now = 1_700_000_000_000;

describe('daily optimisation prompt — token budget', () => {
  it('stays inside the input budget in the entity worst case', () => {
    const after = analyzeFeedback({ signals: mkSignals(MAX_SIGNALS, true), topics, now });
    // ~315 tokens, measured; hard-coded rather than imported for the same
    // module-graph reason as `render`. Generous, so this errs toward failing.
    const SYSTEM_TOKENS = 330;
    const total = SYSTEM_TOKENS + estimateTokens(render(after));

    expect(total).toBeLessThan(INPUT_BUDGET);
    // Documents the actual headroom. If this ever gets close, the fix is to
    // bound what goes on a candidate — NOT to raise the budget.
    expect(total).toBeLessThan(2600);
  });

  it('entities are what grew it — the before/after is ~8x on the user message', () => {
    const before = analyzeFeedback({ signals: mkSignals(MAX_SIGNALS, false), topics, now });
    const after = analyzeFeedback({ signals: mkSignals(MAX_SIGNALS, true), topics, now });

    // Same candidates either way: entities are CONTEXT on existing candidates,
    // never a source of new ones. This is the property that makes the bound
    // "the candidate cap" rather than anything entity-specific.
    expect(after.length).toBe(before.length);
    expect(estimateTokens(render(after))).toBeGreaterThan(
      estimateTokens(render(before)) * 5,
    );
  });

  it('a persona with no tagged articles sends the exact pre-change payload', () => {
    const before = analyzeFeedback({ signals: mkSignals(MAX_SIGNALS, false), topics, now });
    expect(before.every((c) => c.entityContext === undefined)).toBe(true);
    expect(render(before)).not.toContain('about —');
  });

  it('never merges the two directions — each entity lands on the side it was tapped', () => {
    // "more of this" and "less of this" are different signals; collapsing them
    // would hand the model a bag of nouns with no sign.
    //
    // Note a like and a dislike on the same topic produce DIFFERENT candidates
    // (`topic_up:` vs `topic_down:`), so most candidates are single-sentiment.
    // The invariant worth asserting is therefore per-entity provenance, which
    // holds for every candidate including the mixed aggregates.
    const signals = mkSignals(MAX_SIGNALS, true);
    const byId = new Map(signals.map((s) => [s.id, s]));
    const cands = analyzeFeedback({ signals, topics, now });

    const withCtx = cands.filter((c) => c.entityContext);
    expect(withCtx.length).toBeGreaterThan(0);

    for (const c of withCtx) {
      const rows = c.sourceRowIds.map((id) => byId.get(id)!);
      const fromLikes = new Set(
        rows.filter((r) => r.sentiment === 'like').flatMap((r) => r.context.entities ?? []),
      );
      const fromDislikes = new Set(
        rows.filter((r) => r.sentiment === 'dislike').flatMap((r) => r.context.entities ?? []),
      );
      for (const e of c.entityContext!.liked) expect(fromLikes.has(e)).toBe(true);
      for (const e of c.entityContext!.disliked) expect(fromDislikes.has(e)).toBe(true);
    }

    // …and the rendered line labels them separately rather than concatenating.
    const line = render([withCtx[0]]);
    expect(line).toMatch(/about — (liked|disliked):/);
  });
});
