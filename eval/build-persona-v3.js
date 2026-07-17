#!/usr/bin/env node
// Re-express the golden-label fixture persona (.local-test-data/persona.json —
// the v1 facts+topic-strings the 1000 golden labels were judged against) as the
// v3 structured persona the deterministic math engine consumes:
//   - weighted topics (seed weight 0.75, matching the migration seed)
//   - role-tagged locations
//   - empty suppressions / pubPrefs
// Deterministic + replayable. Writes eval/persona-v3.json.
//
// Topics come verbatim from the fixture facts' metadata.topics (deduped by
// normalized text); a topic is location-anchored when its text names a
// location's city → drives the wrong-location guard in the engine.

const fs = require('fs');
const path = require('path');

const PERSONA_PATH =
  process.argv[2] ||
  path.join(__dirname, '..', '.local-test-data', 'persona.json');
const OUT_PATH = path.join(__dirname, 'persona-v3.json');
const SEED_WEIGHT = 0.75; // migration seed (M-P2)

const norm = (s) => (s ?? '').trim().toLowerCase();

// Role-tagged locations (SUB-PLAN F / Wave 7a prompt): home Amsterdam/Nieuw-West
// NL; family Bhopal + family-travel Chhindwara MP IN; partner_family Porto Santo
// Madeira PT; travel Berlin DE. city/region normalized (lower); cc UPPER.
const LOCATIONS = [
  { id: 'loc-amsterdam', city: 'amsterdam', region: 'noord-holland', countryCode: 'NL', role: 'home', weight: 1.0 },
  { id: 'loc-bhopal', city: 'bhopal', region: 'madhya pradesh', countryCode: 'IN', role: 'family', weight: 0.7 },
  { id: 'loc-chhindwara', city: 'chhindwara', region: 'madhya pradesh', countryCode: 'IN', role: 'family_travel', weight: 0.6 },
  { id: 'loc-portosanto', city: 'porto santo', region: 'madeira', countryCode: 'PT', role: 'partner_family', weight: 0.6 },
  { id: 'loc-berlin', city: 'berlin', region: 'berlin', countryCode: 'DE', role: 'travel', weight: 0.5 },
];

// City-name → locationId anchors (checked as case-insensitive substrings; only
// CITY mentions anchor — region/country-level topics stay unanchored so a
// same-region article is NOT wrong-location).
const CITY_ANCHORS = [
  ['nieuw-west', 'loc-amsterdam'],
  ['amsterdam', 'loc-amsterdam'],
  ['bhopal', 'loc-bhopal'],
  ['chhindwara', 'loc-chhindwara'],
  ['porto santo', 'loc-portosanto'],
  ['berlin', 'loc-berlin'],
];

function anchorFor(topicText) {
  const t = norm(topicText);
  for (const [needle, id] of CITY_ANCHORS) {
    if (t.includes(needle)) return id;
  }
  return undefined;
}

function main() {
  const persona = JSON.parse(fs.readFileSync(PERSONA_PATH, 'utf8'));
  const facts = (persona.facts || []).map((f) => ({ id: f.id, weight: 1.0 }));

  const seen = new Set();
  const topics = [];
  let n = 0;
  for (const fact of persona.facts || []) {
    const list = fact.metadata?.topics || [];
    for (const text of list) {
      const normalizedText = norm(text);
      if (!normalizedText || seen.has(normalizedText)) continue;
      seen.add(normalizedText);
      const locationId = anchorFor(text);
      topics.push({
        id: `topic-${++n}`,
        text,
        normalizedText,
        weight: SEED_WEIGHT,
        factId: fact.id,
        status: 'active',
        ...(locationId ? { locationId } : {}),
      });
    }
  }

  const out = {
    provenance: 'build-persona-v3.js over .local-test-data/persona.json',
    seedWeight: SEED_WEIGHT,
    facts,
    locations: LOCATIONS,
    topics,
    suppressions: [],
    pubPrefs: [],
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  const anchored = topics.filter((t) => t.locationId).length;
  console.log(
    `persona-v3.json: ${topics.length} unique topics (${anchored} location-anchored), ` +
      `${facts.length} facts, ${LOCATIONS.length} locations → ${OUT_PATH}`,
  );
}

main();
