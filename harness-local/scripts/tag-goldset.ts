// PHASE 0 of the tag-salvage experiment: run PRODUCTION'S article tagger over the
// frozen 348-article gold set and write `harness-local/fixtures/goldset-348-tagged.json`.
//
//   npx tsx harness-local/scripts/tag-goldset.ts [--limit N] [--dry-run] [--out <path>]
//
// FIDELITY CONTRACT — why this is a port and not a re-implementation
// ------------------------------------------------------------------
// Production tagging is `GeminiEnrichmentService`
// (mera-server/libs/mera-shared/src/enrichment/gemini-enrichment.service.ts).
// Everything decision-bearing here is copied from it BYTE-FOR-BYTE:
//
//   - `buildPrompt` — the exact instruction text, and the exact payload shape
//     `{id, title, description}`. NOTE: production does NOT send the article's
//     own country code to the tagger. The gold fixture HAS `countryCode`, and
//     feeding it in would hand geo extraction a hint production never gets,
//     inflating every geo-overlap rule measured downstream. It is deliberately
//     withheld.
//   - the `generationConfig`: temperature 0, `responseMimeType` application/json,
//     the same `responseSchema`, `thinkingConfig.thinkingBudget: 0`.
//   - `safetySettings`: all four categories at BLOCK_NONE.
//   - `parseAligned` / `normalizeLocations` / `normalizeEntities` /
//     `coerceEventType`: ids kept only when present in the input exactly once;
//     locations dropped when `country_code` is missing OR unmappable (the model
//     emits alpha-3 despite the instruction and production DROPS those, so
//     keeping them would beat prod's geo coverage for a reason that is not real);
//     city/region lower-cased; <=3 locations; <=5 entities, deduped; unknown
//     `event_type` coerced to 'other'.
//   - alpha-2 normalization goes through the same `i18n-iso-countries` calls
//     `CountryCodeMapper.toAlpha2` makes (`isValid` for 2, `alpha3ToAlpha2` for 3).
//   - batch size 40 (`PREPROCESS_ATTENTION_CAP`), which is what drives alignment
//     reliability and therefore the degrade rate.
//   - misaligned/blocked ids retry as SINGLE-item requests, then DEGRADE
//     (`geo_tags: []`, `entities: []`, `event_type: 'other'`) rather than throw.
//
// The one deliberate deviation from prod: this is an OFFLINE generation against
// the frozen fixture, not a read of the tags prod actually stored for these ids.
// It is recorded in the output's `_provenance.tagging`.
//
// Local-only: harness-local is excluded from tsconfig, jest and EAS bundling.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as countries from 'i18n-iso-countries';
import * as en from 'i18n-iso-countries/langs/en.json';

countries.registerLocale(en as never);

// --- Copied verbatim from gemini-enrichment.service.ts ----------------------

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

const EVENT_TYPES = [
  'election',
  'policy',
  'conflict',
  'crime',
  'protest',
  'disaster',
  'accident',
  'weather',
  'business',
  'sports',
  'entertainment',
  'health',
  'science_tech',
  'obituary',
  'other',
] as const;

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

interface GeoTag {
  city?: string;
  region?: string;
  countryCode: string;
}

interface ArticleEnrichment {
  geo_tags: GeoTag[];
  entities: string[];
  event_type: string;
}

/** `CountryCodeMapper.toAlpha2`, same library, same branches. */
function toAlpha2(code: string): string | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  if (normalized.length === 2) return countries.isValid(normalized) ? normalized : null;
  if (normalized.length === 3) return countries.alpha3ToAlpha2(normalized) || null;
  return null;
}

function buildPrompt(items: { id: string; title: string; description: string }[]): string {
  const payload = items.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
  }));
  return [
    'You extract structured geo/entity/event metadata from English news articles.',
    'Return a JSON array with one object per input article, each having exactly',
    'the fields id, locations, entities, event_type. The id MUST match the input',
    'id verbatim. Include every input id exactly once.',
    '',
    'locations: the places the ARTICLE CONTENT is about — NOT the publisher.',
    'Each location is {city, region, country_code}. Use canonical ENGLISH names',
    '("Mumbai" not "Bombay", "Munich" not "München"). region is the state/province',
    '("Madhya Pradesh", "Noord-Holland"). country_code is ISO-3166 alpha-2',
    'UPPERCASE (two letters, e.g. IN not IND, NL not NLD). Include at most 3',
    'locations, ordered most-central-first; omit the array entries when the',
    'article is about no specific place. Omit city or region',
    'when unknown, but always include country_code. Disambiguate same-named places',
    'from the article context (e.g. there are two Dindoris in India — the context',
    'decides which).',
    '',
    'entities: at most 5 canonical English proper nouns (people, organizations,',
    'products) central to the article. Omit generic nouns.',
    '',
    `event_type: exactly one of ${EVENT_TYPES.join(', ')}. Use 'other' when none fit.`,
    '',
    `Articles: ${JSON.stringify(payload)}`,
  ].join('\n');
}

function normalizeLocations(raw: unknown, onUnmappable: (cc: string) => void): GeoTag[] {
  if (!Array.isArray(raw)) return [];
  const out: GeoTag[] = [];
  for (const loc of raw) {
    const l = loc as { city?: unknown; region?: unknown; country_code?: unknown };
    const rawCc = typeof l.country_code === 'string' ? l.country_code.trim() : '';
    if (!rawCc) continue;
    const countryCode = toAlpha2(rawCc);
    if (!countryCode) {
      onUnmappable(rawCc);
      continue;
    }
    const tag: GeoTag = { countryCode };
    if (typeof l.city === 'string' && l.city.trim()) tag.city = l.city.trim().toLowerCase();
    if (typeof l.region === 'string' && l.region.trim()) tag.region = l.region.trim().toLowerCase();
    out.push(tag);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeEntities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const v = e.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

function coerceEventType(raw: unknown): string {
  return typeof raw === 'string' && EVENT_TYPE_SET.has(raw) ? raw : 'other';
}

// --- The call ---------------------------------------------------------------

const MODELS = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite'];
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const ATTENTION_CAP = 40; // PREPROCESS_ATTENTION_CAP
const MAX_RETRIES = 3;
const BACKOFF_MS = 500;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

const stats = {
  requests: 0,
  safetyBlocks: 0,
  promptTokens: 0,
  candidateTokens: 0,
  unmappableCountryCodes: [] as string[],
  singleRetries: 0,
  degraded: [] as string[],
};

let modelIndex = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TransientError extends Error {}
class ModelUnavailable extends Error {}

async function requestOnce(
  apiKey: string,
  items: { id: string; title: string; description: string }[],
): Promise<{ byId: Map<string, ArticleEnrichment>; safetyBlocked: boolean }> {
  stats.requests++;
  const model = MODELS[modelIndex];
  const url = `${BASE_URL}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(items) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            locations: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  city: { type: 'STRING' },
                  region: { type: 'STRING' },
                  country_code: { type: 'STRING' },
                },
                required: ['country_code'],
              },
            },
            entities: { type: 'ARRAY', items: { type: 'STRING' } },
            event_type: { type: 'STRING', enum: [...EVENT_TYPES] },
          },
          required: ['id', 'locations', 'entities', 'event_type'],
        },
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_NONE' })),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TransientError(`network error: ${(err as Error).message}`);
  }

  if (res.status === 429 || res.status >= 500) {
    throw new TransientError(`gemini ${res.status}`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 404 || /NOT_FOUND/.test(txt)) throw new ModelUnavailable(`${res.status}`);
    throw new Error(`gemini ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = (await res.json()) as GeminiResponse;
  stats.promptTokens += json.usageMetadata?.promptTokenCount ?? 0;
  stats.candidateTokens += json.usageMetadata?.candidatesTokenCount ?? 0;

  const cand = json.candidates?.[0];
  const blocked =
    json.promptFeedback?.blockReason !== undefined || cand?.finishReason === 'SAFETY';
  const text = cand?.content?.parts?.[0]?.text;
  if (!text) return { byId: new Map(), safetyBlocked: blocked };

  const inputIds = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const byId = new Map<string, ArticleEnrichment>();
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    return { byId, safetyBlocked: blocked };
  }
  if (!Array.isArray(arr)) return { byId, safetyBlocked: blocked };
  for (const row of arr) {
    const r = row as { id?: unknown; locations?: unknown; entities?: unknown; event_type?: unknown };
    const id = typeof r.id === 'string' ? r.id : undefined;
    if (!id || !inputIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    byId.set(id, {
      geo_tags: normalizeLocations(r.locations, (cc) => stats.unmappableCountryCodes.push(cc)),
      entities: normalizeEntities(r.entities),
      event_type: coerceEventType(r.event_type),
    });
  }
  return { byId, safetyBlocked: blocked };
}

async function requestWithRetry(
  apiKey: string,
  items: { id: string; title: string; description: string }[],
): Promise<{ byId: Map<string, ArticleEnrichment>; safetyBlocked: boolean }> {
  let attempt = 0;
  for (;;) {
    try {
      return await requestOnce(apiKey, items);
    } catch (err) {
      if (err instanceof ModelUnavailable) {
        if (modelIndex < MODELS.length - 1) {
          modelIndex++;
          continue;
        }
        throw err;
      }
      if (err instanceof TransientError && attempt < MAX_RETRIES) {
        attempt++;
        await sleep(BACKOFF_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw err;
    }
  }
}

// --- Fixture plumbing -------------------------------------------------------

interface GoldArticle {
  articleId: string;
  title: string;
  description: string;
  countryCode: string | null;
  relatedFacts: string[];
  jComp: number;
  verdict: string;
  v1Relevance: number | null;
}

interface Fixture {
  _provenance: Record<string, unknown>;
  personaFacts: { statement: string }[];
  articles: GoldArticle[];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const limit = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : undefined;
  const dryRun = argv.includes('--dry-run');
  const outPath = argv.includes('--out')
    ? argv[argv.indexOf('--out') + 1]
    : join(__dirname, '..', 'fixtures', 'goldset-348-tagged.json');
  const srcPath = join(__dirname, '..', 'fixtures', 'goldset-348.json');
  const keyPath =
    process.env.GEMINI_KEY_FILE ??
    '/private/tmp/claude-501/-Users-abhijeetchakraborty-Code-mera-news/' +
      'a209fe47-6138-4f0c-81e2-efed380cd6e7/scratchpad/.gemini_key';

  const fx = JSON.parse(readFileSync(srcPath, 'utf8')) as Fixture;
  const articles = typeof limit === 'number' ? fx.articles.slice(0, limit) : fx.articles;
  const log = (s: string) => console.log(s); // eslint-disable-line no-console

  log(`source fixture : ${srcPath}`);
  log(`articles       : ${articles.length}`);
  log(`batch size     : ${ATTENTION_CAP} → ${Math.ceil(articles.length / ATTENTION_CAP)} requests`);
  log(`model chain    : ${MODELS.join(' → ')}`);
  if (dryRun) {
    log('\n--- sample prompt (first batch, truncated to 3 articles) ---');
    log(
      buildPrompt(
        articles.slice(0, 3).map((a) => ({
          id: a.articleId,
          title: a.title,
          description: a.description,
        })),
      ),
    );
    log('\n--dry-run: nothing sent.');
    return 0;
  }

  const apiKey = readFileSync(keyPath, 'utf8').trim();
  if (!apiKey) throw new Error('empty GEMINI key');

  const items = articles.map((a) => ({
    id: a.articleId,
    title: a.title,
    description: a.description,
  }));

  const enrichment = new Map<string, ArticleEnrichment>();
  for (let i = 0; i < items.length; i += ATTENTION_CAP) {
    const batch = items.slice(i, i + ATTENTION_CAP);
    const started = Date.now();
    const primary = await requestWithRetry(apiKey, batch);
    const missing = batch.filter((b) => !primary.byId.has(b.id));
    for (const [id, e] of primary.byId) enrichment.set(id, e);
    // Misaligned/blocked subset retries SINGLE, then degrades — production's path.
    for (const m of missing) {
      stats.singleRetries++;
      try {
        const single = await requestWithRetry(apiKey, [m]);
        const hit = single.byId.get(m.id);
        if (hit) {
          enrichment.set(m.id, hit);
          continue;
        }
        if (single.safetyBlocked) stats.safetyBlocks++;
      } catch {
        /* fall through to degrade */
      }
      stats.degraded.push(m.id);
      enrichment.set(m.id, { geo_tags: [], entities: [], event_type: 'other' });
    }
    log(
      `batch ${i / ATTENTION_CAP + 1}: ${batch.length} in, ${primary.byId.size} aligned, ` +
        `${missing.length} single-retried — ${Math.round((Date.now() - started) / 1000)}s`,
    );
  }

  const INPUT_USD_PER_TOKEN = 0.1 / 1_000_000;
  const OUTPUT_USD_PER_TOKEN = 0.4 / 1_000_000;
  const costUsd =
    stats.promptTokens * INPUT_USD_PER_TOKEN + stats.candidateTokens * OUTPUT_USD_PER_TOKEN;

  const taggedArticles = articles.map((a) => {
    const e = enrichment.get(a.articleId);
    return {
      ...a,
      geoTags: e?.geo_tags ?? [],
      entities: e?.entities ?? [],
      eventType: e?.event_type ?? null,
      tagsDegraded: stats.degraded.includes(a.articleId),
    };
  });

  const withGeo = taggedArticles.filter((a) => a.geoTags.length > 0).length;
  const withEnt = taggedArticles.filter((a) => a.entities.length > 0).length;
  const withEvt = taggedArticles.filter((a) => a.eventType != null).length;
  const withEvtNonOther = taggedArticles.filter(
    (a) => a.eventType != null && a.eventType !== 'other',
  ).length;

  const out = {
    _provenance: {
      ...fx._provenance,
      tagging: {
        generatedOn: new Date().toISOString().slice(0, 10),
        generatedAt: new Date().toISOString(),
        model: MODELS[modelIndex],
        modelChain: MODELS,
        sourceFixture: 'harness-local/fixtures/goldset-348.json',
        promptOrigin: {
          file: 'mera-server/libs/mera-shared/src/enrichment/gemini-enrichment.service.ts',
          symbol: 'GeminiEnrichmentService.buildPrompt + requestOnce generationConfig',
          sha256: process.env.PROMPT_ORIGIN_SHA ?? null,
        },
        note:
          'GENERATED OFFLINE against the frozen fixture — these are NOT the tags prod stored ' +
          'for these article ids. Prompt, responseSchema, temperature (0), thinkingBudget (0), ' +
          'safety thresholds, batch size (40), the single-item retry and the whole normalization ' +
          'layer are ported byte-for-byte from GeminiEnrichmentService. The article countryCode ' +
          'present in this fixture is deliberately NOT sent to the tagger, because production ' +
          'sends {id,title,description} only.',
        batchSize: ATTENTION_CAP,
        requests: stats.requests,
        singleRetries: stats.singleRetries,
        degradedIds: stats.degraded,
        safetyBlocks: stats.safetyBlocks,
        unmappableCountryCodes: stats.unmappableCountryCodes,
        promptTokens: stats.promptTokens,
        candidateTokens: stats.candidateTokens,
        estimatedCostUsd: costUsd,
        coverage: {
          n: taggedArticles.length,
          geoTags: withGeo,
          entities: withEnt,
          eventType: withEvt,
          eventTypeNonOther: withEvtNonOther,
        },
      },
    },
    personaFacts: fx.personaFacts,
    articles: taggedArticles,
  };

  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  log(`\n--- coverage over n=${taggedArticles.length} ---`);
  log(`geo_tags   : ${withGeo} (${((100 * withGeo) / taggedArticles.length).toFixed(1)}%)`);
  log(`entities   : ${withEnt} (${((100 * withEnt) / taggedArticles.length).toFixed(1)}%)`);
  log(`event_type : ${withEvt} (${((100 * withEvt) / taggedArticles.length).toFixed(1)}%) — ` +
      `non-'other' ${withEvtNonOther} (${((100 * withEvtNonOther) / taggedArticles.length).toFixed(1)}%)`);
  log(`degraded   : ${stats.degraded.length}`);
  log(`unmappable country codes dropped: ${stats.unmappableCountryCodes.length} ` +
      `[${[...new Set(stats.unmappableCountryCodes)].join(', ')}]`);
  log(
    `spend      : ${stats.requests} requests, ${stats.promptTokens} in / ` +
      `${stats.candidateTokens} out tokens, $${costUsd.toFixed(5)} ` +
      `($${((costUsd / taggedArticles.length) * 1000).toFixed(4)}/1,000 articles)`,
  );
  log(`written    : ${outPath}`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e); // eslint-disable-line no-console
    process.exit(1);
  });
