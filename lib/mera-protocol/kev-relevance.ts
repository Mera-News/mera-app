// On-device relevance with Kev (a decision model, llama.rn context.decide()). It plugs into
// computeAndScore as the RelevanceScorer, so the shared penalties and the hard screen still apply.
// One decide() call per article: the toolkit takes the llama lock per request, so a chat turn can
// step in between two articles.

import logger from '@/lib/logger';
import { decide } from '@/lib/mera-protocol-toolkit';
import { resolveCountryName } from '@/lib/news-harness/article-pipeline/scoring';
import type { RelevanceScorer } from '@/lib/news-harness/scoring-engine/run-stage';

export const KEV_QUESTIONS = {
  rel: {
    type: 'score',
    instructions:
      'How relevant is this news article to this reader, given everything known about them? A story about the domestic affairs of a country the reader has no link to is not relevant, even when its subject matches one of their interests.',
    criteria: [
      "Not relevant: no real link to the reader's life, work, location or interests",
      'Low: only a loose or generic link to the reader',
      "Medium: clearly about one of the reader's interests, their work field, or their country",
      "High: directly affects the reader's daily life, job or home area, or is a major development in a core interest",
    ],
  },
} as const;

/** Kev score (0..1) that maps to the feed's 0.4 gate.
 *  Cloud kev-4b (goldset-348, full precision and fp8 identical): 0.62 kept about the small model's
 *  feed size (~28%, ~96 of 348 rows). On the phone (Kev-4B Q4_K_M on llama.rn 0.13.0-rc.7, iPhone 18
 *  Pro, 2026-10-19) the same model scores much lower: over 97 real articles the median k was 0.20,
 *  the max 0.63, and 0.62 let 1 row through. 0.29 is the top-28% point of that sample, so it keeps
 *  the cloud feed size on the phone's own scale.
 *  ponytail: fitted on one unlabelled evening of one feed; refit on goldset-348 run through the same
 *  Q4 file before trusting the bands above the gate. */
export const KEV_CUT = 0.29;

const DESCRIPTION_CHARS = 500;

/** Characters of facts per list (the fact bank, and the facts this article matched). Kev's whole
 *  prompt must fit n_ctx 4096 tokens, or decide fails with "(error 1)". Measured on the Mac with
 *  harness-local/adapters/kev-local.ts: English runs about 5 characters a token, so two full lists,
 *  a long title and the description stay near 3,000 tokens; a 7-fact bank is far below the cap.
 *  ponytail: a character budget; a non-Latin fact bank tokenizes denser and can still overflow.
 *  Count tokens (context.tokenize) if one does. */
export const KEV_FACT_CHARS = 6000;
const LEVELS_MAX = KEV_QUESTIONS.rel.criteria.length - 1;

/** Piecewise linear: [0, KEV_CUT] onto [0, 0.4], [KEV_CUT, 1] onto [0.4, 1]. */
export function kevToRelevance(k: number): number {
  const v = k < KEV_CUT ? (0.4 * k) / KEV_CUT : 0.4 + (0.6 * (k - KEV_CUT)) / (1 - KEV_CUT);
  return Math.min(1, Math.max(0, v));
}

type KevCandidate = Parameters<RelevanceScorer>[0][number];

/** The leading facts (the newest: getFacts sorts newest first) that fit KEV_FACT_CHARS. */
function withinBudget(facts: string[]): string[] {
  let used = 0;
  const kept: string[] = [];
  for (const f of facts) {
    used += f.length;
    if (used > KEV_FACT_CHARS) break;
    kept.push(f);
  }
  return kept;
}

export function kevState(candidate: KevCandidate, facts: string[]) {
  const country = candidate.countryCode === 'GLOBAL' ? undefined : resolveCountryName(candidate.countryCode);
  return {
    reader: withinBudget(facts),
    reader_facts_this_article_matched: withinBudget(candidate.relatedFacts.map((f) => f.statement)),
    article: {
      title: candidate.titleEn,
      description: candidate.descriptionEn?.slice(0, DESCRIPTION_CHARS) ?? null,
      ...(country ? { country } : {}),
    },
  };
}

/** The error's first 160 characters with every piece of the request's text taken out (the
 *  article and each fact), then anything quoted: llama.rn errors can echo the prompt. */
function scrubbed(error: unknown, state: ReturnType<typeof kevState>): string {
  let message = error instanceof Error ? error.message : String(error);
  const texts = [state.article.title, state.article.description, ...state.reader, ...state.reader_facts_this_article_matched];
  for (const text of texts) if (text && text.length > 2) message = message.split(text).join('…');
  return message.replace(/"[^"]*"|'[^']*'/g, '"…"').slice(0, 160);
}

/** A KevBusyError (lib/mera-protocol-toolkit/core/inference.ts): the app went to the background
 *  or the GPU failed twice, so every later article would fail too. */
const isKevBusy = (e: unknown) => (e as { code?: unknown } | null)?.code === 'ERR_AFM_BUSY';

/**
 * Kev's relevance per article. An error about one article (its prompt too long, a template
 * failure) keeps that row on its math score. Busy (background, or a GPU that will not recover)
 * throws instead, so batchScoreAndReason marks the whole batch failed and its rows stay unscored
 * for the next pass, rather than landing on math scores Kev never saw.
 */
export const scoreWithKev: RelevanceScorer = async (candidates, factStatements) => {
  const out = new Map<string, number>();
  for (const c of candidates) {
    const state = kevState(c, factStatements);
    try {
      const result = await decide({ state, questions: KEV_QUESTIONS });
      out.set(c.id, kevToRelevance(result.answers.rel.score / LEVELS_MAX));
    } catch (e) {
      if (isKevBusy(e)) throw e;
      logger.warn('kev_decide_failed', {
        id: c.id,
        error: e instanceof Error ? e.name : typeof e,
        message: scrubbed(e, state),
        stateChars: JSON.stringify(state).length,
      });
    }
  }
  return out;
};
