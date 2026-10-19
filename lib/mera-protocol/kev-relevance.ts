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

/** Kev score (0..1) that maps to the feed's 0.4 gate. Measured on goldset-348 (cloud kev-4b, full
 *  precision and fp8 identical): a cut of 0.62 gives about the same feed size as the small model's
 *  0.4 gate, ~96 rows. */
export const KEV_CUT = 0.62;

const DESCRIPTION_CHARS = 500;
const LEVELS_MAX = KEV_QUESTIONS.rel.criteria.length - 1;

/** Piecewise linear: [0, KEV_CUT] onto [0, 0.4], [KEV_CUT, 1] onto [0.4, 1]. */
export function kevToRelevance(k: number): number {
  const v = k < KEV_CUT ? (0.4 * k) / KEV_CUT : 0.4 + (0.6 * (k - KEV_CUT)) / (1 - KEV_CUT);
  return Math.min(1, Math.max(0, v));
}

type KevCandidate = Parameters<RelevanceScorer>[0][number];

export function kevState(candidate: KevCandidate, facts: string[]) {
  const country = candidate.countryCode === 'GLOBAL' ? undefined : resolveCountryName(candidate.countryCode);
  return {
    reader: facts,
    reader_facts_this_article_matched: candidate.relatedFacts.map((f) => f.statement),
    article: {
      title: candidate.titleEn,
      description: candidate.descriptionEn?.slice(0, DESCRIPTION_CHARS) ?? null,
      ...(country ? { country } : {}),
    },
  };
}

export const scoreWithKev: RelevanceScorer = async (candidates, factStatements) => {
  const out = new Map<string, number>();
  for (const c of candidates) {
    try {
      const result = await decide({ state: kevState(c, factStatements), questions: KEV_QUESTIONS });
      out.set(c.id, kevToRelevance(result.answers.rel.score / LEVELS_MAX));
    } catch (e) {
      // Ids and the error class only: the error text can quote the persona.
      logger.warn('kev_decide_failed', { id: c.id, error: e instanceof Error ? e.name : typeof e });
    }
  }
  return out;
};
