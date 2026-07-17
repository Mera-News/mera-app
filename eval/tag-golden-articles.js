#!/usr/bin/env node
// Offline Gemini tagging of the 1000 golden eval articles → eval/golden-tags.json.
//
// Runs the SAME tagging prompt/schema/normalization the server ships
// (mera-server/libs/mera-shared/src/tagging/gemini-tagging.service.ts) over the
// golden article set so the deterministic scoring engine's geo/entity/event
// components are exercised in the eval. Replayable: already-tagged ids are
// skipped on re-run (delete golden-tags.json to force a full re-tag).
//
// Usage:
//   GEMINI_API_KEY=$(gcloud secrets versions access latest --secret=GEMINI_API_KEY) \
//     node eval/tag-golden-articles.js \
//       [--articles <runDir>/articles.json] [--batch 40] [--limit N]
//
// Writes eval/golden-tags.json  { [articleId]: { geo_tags, entities, event_type } }.

const fs = require('fs');
const path = require('path');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const ARTICLES_PATH = getArg(
  '--articles',
  path.join(
    __dirname,
    '..',
    '.local-test-data',
    'runs',
    '20260716-190647-prod-baseline',
    'articles.json',
  ),
);
const BATCH = Number(getArg('--batch', '40'));
const LIMIT = getArg('--limit', undefined);
const OUT_PATH = path.join(__dirname, 'golden-tags.json');

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('GEMINI_API_KEY not set (fetch via gcloud secrets)');
  process.exit(1);
}
const MODEL = process.env.GEMINI_TAGGING_MODEL || 'gemini-2.5-flash-lite';
const BASE_URL =
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta';

// ---- ported vocabulary / normalization (mirror of the server service) -----
const EVENT_TYPES = [
  'election', 'policy', 'conflict', 'crime', 'protest', 'disaster', 'accident',
  'weather', 'business', 'sports', 'entertainment', 'health', 'science_tech',
  'obituary', 'other',
];
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

function coerceEventType(raw) {
  return typeof raw === 'string' && EVENT_TYPE_SET.has(raw) ? raw : 'other';
}
function normalizeLocations(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const loc of raw) {
    const cc = typeof loc?.country_code === 'string' ? loc.country_code.trim() : '';
    if (!cc) continue;
    const tag = { countryCode: cc.toUpperCase() };
    if (typeof loc.city === 'string' && loc.city.trim()) tag.city = loc.city.trim().toLowerCase();
    if (typeof loc.region === 'string' && loc.region.trim()) tag.region = loc.region.trim().toLowerCase();
    out.push(tag);
    if (out.length >= 3) break;
  }
  return out;
}
function normalizeEntities(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
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

// ---- prompt (verbatim port of GeminiTaggingService.buildPrompt) -----------
function buildPrompt(items) {
  const payload = items.map((i) => ({
    id: i.id,
    title: i.title_en,
    description: i.description_en,
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
    'UPPERCASE. Include at most 3 locations, ordered most-central-first; omit the',
    'array entries when the article is about no specific place. Omit city or region',
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

const RESPONSE_SCHEMA = {
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
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tagBatch(items, attempt = 0) {
  const url = `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(items) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_NONE' })),
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (attempt < 4) { await sleep(500 * 2 ** attempt); return tagBatch(items, attempt + 1); }
    throw err;
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 5) { await sleep(800 * 2 ** attempt); return tagBatch(items, attempt + 1); }
    throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  const inputIds = new Set(items.map((i) => i.id));
  const seen = new Set();
  const byId = new Map();
  if (text) {
    let arr;
    try { arr = JSON.parse(text); } catch { arr = null; }
    if (Array.isArray(arr)) {
      for (const row of arr) {
        const id = typeof row?.id === 'string' ? row.id : undefined;
        if (!id || !inputIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        byId.set(id, {
          geo_tags: normalizeLocations(row.locations),
          entities: normalizeEntities(row.entities),
          event_type: coerceEventType(row.event_type),
        });
      }
    }
  }
  return byId;
}

async function main() {
  const articles = JSON.parse(fs.readFileSync(ARTICLES_PATH, 'utf8'));
  const items = articles
    .map((a) => ({ id: a._id, title_en: a.title_en ?? '', description_en: a.description_en ?? '' }))
    .filter((a) => a.id);
  const capped = LIMIT ? items.slice(0, Number(LIMIT)) : items;

  const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  const pending = capped.filter((i) => !out[i.id]);
  console.log(`tagging ${pending.length} / ${capped.length} articles (batch ${BATCH}), ${Object.keys(out).length} already cached`);

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const byId = await tagBatch(batch);
    // Any id the model dropped → degrade (empty tags), matching server semantics.
    for (const item of batch) {
      out[item.id] = byId.get(item.id) || { geo_tags: [], entities: [], event_type: 'other' };
    }
    done += batch.length;
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 0));
    console.log(`  ${done}/${pending.length} tagged (batch ${Math.floor(i / BATCH) + 1})`);
  }
  console.log(`done → ${OUT_PATH} (${Object.keys(out).length} total)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
