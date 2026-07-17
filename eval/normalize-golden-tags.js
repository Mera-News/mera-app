#!/usr/bin/env node
// One-off: normalize golden-tags.json geo_tags[].countryCode from ISO alpha-3
// to alpha-2 so the on-device geo scorer (which keys country matches on the
// persona's alpha-2 codes: NL/IN/DE/PT/…) actually matches. ~16% of the tagged
// geo tags came back alpha-3 (DEU/IND/PRT/NLD/USA/…) from the offline Gemini
// tagging pass and silently missed geo matching until now.
//
// Idempotent: alpha-2 codes are left untouched; unknown/region codes (EU/EUR)
// are upper-cased but otherwise preserved. Rewrites eval/golden-tags.json in
// place. Kept in-tree (not deleted) so the mapping is auditable/re-runnable.
//
//   node eval/normalize-golden-tags.js

const fs = require('fs');
const path = require('path');

// Static ISO alpha-3 → alpha-2 map covering every alpha-3 code present in the
// current golden-tags.json (see the distinct-code audit). EUR is not a country
// (Europe); mapped to EU to stay consistent with the alpha-2 region marker the
// tagger already emits — it never matches a persona location either way.
const ALPHA3_TO_ALPHA2 = {
  AGO: 'AO', ALB: 'AL', BEL: 'BE', BGR: 'BG', BIH: 'BA', BRA: 'BR',
  CAN: 'CA', CHN: 'CN', CPV: 'CV', DEU: 'DE', ESP: 'ES', EST: 'EE',
  EUR: 'EU', FRA: 'FR', GBR: 'GB', HUN: 'HU', IDN: 'ID', IND: 'IN',
  JPN: 'JP', KOR: 'KR', LTU: 'LT', NLD: 'NL', NPL: 'NP', PAK: 'PK',
  PRT: 'PT', RUS: 'RU', SUR: 'SR', THA: 'TH', UKR: 'UA', USA: 'US',
};

function normCode(cc) {
  if (typeof cc !== 'string') return cc;
  const up = cc.trim().toUpperCase();
  if (up.length === 3 && ALPHA3_TO_ALPHA2[up]) return ALPHA3_TO_ALPHA2[up];
  return up;
}

function main() {
  const file = path.join(__dirname, 'golden-tags.json');
  const tags = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = 0;
  let total = 0;
  for (const id of Object.keys(tags)) {
    const geo = tags[id].geo_tags;
    if (!Array.isArray(geo)) continue;
    for (const g of geo) {
      if (!g || typeof g.countryCode !== 'string') continue;
      total++;
      const next = normCode(g.countryCode);
      if (next !== g.countryCode) changed++;
      g.countryCode = next;
    }
  }
  fs.writeFileSync(file, JSON.stringify(tags, null, 2));
  console.log(`normalize-golden-tags: ${changed} of ${total} geo-tag country codes rewritten → ${file}`);
}

main();
