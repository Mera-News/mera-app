// Build a unified per-article eval-score file for eval-golden.js.
//
//   npx tsx --tsconfig harness-local/tsconfig.json \
//     eval/lib/build-eval-scores.ts <runDir> <engine: math|backstop>
//
// Both engines emit the SAME shape (id, titleEn, rawScore, wrongLocation, …) so
// eval-golden.js reports tiers + the wrong-location leak counter identically:
//   - math    : rawScore = computeRelevance() over persona-v3.json + golden-tags.json
//               (a fake judge returning "ok" → the math score stands unchanged).
//   - backstop: rawScore = the run's recorded scores.json (today's LLM path,
//               untouched); wrongLocation still resolved on-device for the leak
//               metric so both modes report the same product-critical number.
//
// Writes <runDir>/eval-scores-<engine>.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HARNESS_CONFIG } from '../../lib/news-harness/core/config';
import {
  computeRelevance,
  resolveGeoMatch,
  type ScoredCandidateInput,
  type MatchedTopicInput,
  type PersonaScoringContext,
  type PersonaLocationSnapshot,
  type ArticleGeoTag,
} from '../../lib/news-harness/scoring-engine';

type Engine = 'math' | 'backstop';

interface PersonaV3 {
  seedWeight: number;
  facts: { id: string; weight: number }[];
  locations: PersonaLocationSnapshot[];
  topics: {
    id: string;
    text: string;
    normalizedText: string;
    weight: number;
    factId: string;
    locationId?: string;
    status: string;
  }[];
  suppressions: { keywords: string[]; strength: number }[];
  pubPrefs: { publicationName: string; weight: number }[];
}

interface Candidate {
  id: string;
  titleEn: string | null;
  descriptionEn: string | null;
  countryCode: string | null;
  userTopicIds: string[]; // topic TEXTS in the replay
}

interface Article {
  _id: string;
  pubDate?: string;
  publication_name?: string | null;
  country_code?: string | null;
  clusters?: { clusterId: string }[];
}

interface GoldenTag {
  geo_tags: ArticleGeoTag[];
  entities: string[];
  event_type: string;
}

const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

function main(): void {
  const runDir = process.argv[2];
  const engine = (process.argv[3] as Engine) ?? 'math';
  if (!runDir || (engine !== 'math' && engine !== 'backstop')) {
    console.error('usage: build-eval-scores.ts <runDir> <math|backstop>');
    process.exit(1);
  }

  const evalDir = join(__dirname, '..');
  const persona = readJson<PersonaV3>(join(evalDir, 'persona-v3.json'));
  const tags = readJson<Record<string, GoldenTag>>(join(evalDir, 'golden-tags.json'));
  const candidates = readJson<Candidate[]>(join(runDir, 'candidates.json'));
  const articles = readJson<Article[]>(join(runDir, 'articles.json'));

  const cfg = DEFAULT_HARNESS_CONFIG.scoringEngine;

  // fact weight + topic-text lookup ---------------------------------------
  const factWeight = new Map(persona.facts.map((f) => [f.id, f.weight]));
  const topicByText = new Map(persona.topics.map((t) => [t.normalizedText, t]));

  // article metadata by id ------------------------------------------------
  const artById = new Map(articles.map((a) => [a._id, a]));
  const pubDates = articles
    .map((a) => (a.pubDate ? Date.parse(a.pubDate) : NaN))
    .filter((n) => !Number.isNaN(n));
  const nowMs = pubDates.length ? Math.max(...pubDates) : Date.now();

  const persona2: PersonaScoringContext = {
    locations: persona.locations,
    pubPrefs: new Map(persona.pubPrefs.map((p) => [norm(p.publicationName), p.weight])),
    softSuppressions: persona.suppressions,
  };

  // backstop rawScores (today's recorded LLM path) ------------------------
  let backstopScore = new Map<string, number>();
  if (engine === 'backstop') {
    const scores = readJson<{ id: string; rawScore: number }[]>(join(runDir, 'scores.json'));
    backstopScore = new Map(scores.map((s) => [s.id, s.rawScore]));
  }

  const out = candidates.map((c) => {
    const tag = tags[c.id];
    const art = artById.get(c.id);

    const matchedTopics: MatchedTopicInput[] = [];
    for (const text of c.userTopicIds ?? []) {
      const t = topicByText.get(norm(text));
      if (!t) continue;
      const fw = factWeight.get(t.factId) ?? 1;
      const effectiveWeight = Math.max(-1, Math.min(1, t.weight * fw));
      matchedTopics.push({
        topicId: t.id,
        effectiveWeight,
        locationId: t.locationId,
      });
    }

    const input: ScoredCandidateInput = {
      id: c.id,
      titleEn: c.titleEn,
      descriptionEn: c.descriptionEn,
      publicationName: art?.publication_name ?? null,
      countryCode: c.countryCode ?? art?.country_code ?? null,
      pubDateMs: art?.pubDate ? Date.parse(art.pubDate) : null,
      maxClusterSize: null, // cluster sizes not captured in the replay
      eventType: tag?.event_type ?? null,
      geoTags: tag?.geo_tags ?? [],
      entities: tag?.entities ?? [],
      matchedTopics,
    };

    // wrong-location (same resolution for both engines → same leak metric)
    const anchoredIds = new Set(
      matchedTopics.filter((t) => t.effectiveWeight > 0 && t.locationId).map((t) => t.locationId!),
    );
    const geo = resolveGeoMatch(input.geoTags ?? [], persona.locations, cfg, anchoredIds);

    let rawScore: number;
    let comp: Record<string, number> | undefined;
    if (engine === 'math') {
      const r = computeRelevance(input, persona2, cfg, nowMs);
      rawScore = r.score;
      comp = {
        topic: +r.components.topicComp.toFixed(3),
        geo: +r.components.geoComp.toFixed(3),
        entity: +r.components.entityComp.toFixed(3),
        event: +r.components.eventComp.toFixed(3),
        pop: +r.components.popComp.toFixed(3),
        fresh: +r.components.freshComp.toFixed(3),
        base: +r.components.base.toFixed(3),
        negP: +r.components.negTopicPenalty.toFixed(3),
        wrongP: +r.components.wrongLocPenalty.toFixed(3),
      };
    } else {
      rawScore = backstopScore.get(c.id) ?? 0;
    }

    return {
      id: c.id,
      titleEn: c.titleEn,
      rawScore,
      wrongLocation: geo.wrongLocationFlag,
      geoAlignment: geo.alignment,
      matchedTopicCount: matchedTopics.length,
      ...(comp ? { comp } : {}),
    };
  });

  const outPath = join(runDir, `eval-scores-${engine}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 0));
  const leak = out.filter((r) => r.rawScore >= 0.4 && r.wrongLocation === 1).length;
  console.error(
    `[build-eval-scores] engine=${engine} rows=${out.length} nowMs=${new Date(nowMs).toISOString()} ` +
      `feedWrongLoc=${leak} → ${outPath}`,
  );
}

main();
