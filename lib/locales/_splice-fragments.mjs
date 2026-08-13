#!/usr/bin/env node
// Splice a fragment file into the 20 locale dictionaries.
//
//   node lib/locales/_splice-fragments.mjs lib/locales/_intercom-fragments.json
//   node lib/locales/_splice-fragments.mjs <fragments.json> --check
//
// WHY THIS EXISTS: hand-editing the dictionaries, or fanning the edit out one
// file per agent, corrupted four of them in an earlier wave. Adding a key is a
// mechanical operation on 20 files and belongs in a script that either does all
// 20 identically or refuses.
//
// Guarantees, all enforced below rather than assumed:
//   - Non-ASCII is written through verbatim. JSON.stringify does not escape it;
//     the equivalent in another language usually does by default, and an
//     escaped round-trip is exactly how ar/hi/ja/zh got mangled before.
//   - Existing keys are never overwritten. A collision is an error, not a merge.
//   - Key ORDER is preserved for existing namespaces; new keys append.
//   - Indentation is DETECTED per file, never assumed. Hardcoding it rewrote
//     all 4,500 lines of every dictionary on the first run: a real one-key diff
//     buried in a whole-file reformat is unreviewable, and unreviewable is how
//     a corrupt dictionary ships.
//   - NOTHING is written until every locale has been validated. Writing inside
//     the loop and checking afterwards left 20 modified files on disk after the
//     run had already failed.
//   - Afterwards every dictionary must parse AND carry an identical key set,
//     comparing i18next plural FAMILIES rather than raw keys: CLDR gives
//     Arabic six plural forms and Chinese one, so `_few`/`_many`/`_two`/`_zero`
//     legitimately differ per language and are not drift.
//
// Nothing imports this file: lib/i18n/index.ts lists the 20 dictionaries by
// explicit import, so a stray .mjs/.json beside them is inert at runtime.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = dirname(fileURLToPath(import.meta.url));

// i18next appends a CLDR plural category to the base key. Which categories
// exist is a property of the LANGUAGE, so these must be normalised away before
// two dictionaries' key sets can be compared.
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** Indent width of an existing JSON file, so a splice is a one-line diff. */
function detectIndent(raw) {
  const m = raw.match(/\n([ \t]+)"/);
  if (!m) return 2;
  return m[1] === '\t' ? '\t' : m[1].length;
}

const fragmentsPath = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!fragmentsPath) {
  console.error('usage: _splice-fragments.mjs <fragments.json> [--check]');
  process.exit(2);
}

const dictFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

const fragments = JSON.parse(readFileSync(resolve(fragmentsPath), 'utf8'));
delete fragments._comment;

const fragmentLocales = Object.keys(fragments).sort();
const dictLocales = dictFiles.map((f) => f.replace(/\.json$/, ''));

const missing = dictLocales.filter((l) => !fragmentLocales.includes(l));
const extra = fragmentLocales.filter((l) => !dictLocales.includes(l));
if (missing.length || extra.length) {
  console.error('Fragment locales do not match the dictionaries.');
  if (missing.length) console.error('  missing fragments for:', missing.join(', '));
  if (extra.length) console.error('  fragments for unknown locales:', extra.join(', '));
  process.exit(1);
}

/** Merge `src` into `dst`, refusing to overwrite an existing leaf. */
function mergeStrict(dst, src, path, collisions) {
  for (const [key, value] of Object.entries(src)) {
    const here = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (dst[key] === undefined) dst[key] = {};
      else if (typeof dst[key] !== 'object' || Array.isArray(dst[key])) {
        collisions.push(`${here} (existing value is not an object)`);
        continue;
      }
      mergeStrict(dst[key], value, here, collisions);
    } else if (dst[key] !== undefined) {
      if (dst[key] !== value) collisions.push(here);
    } else {
      dst[key] = value;
    }
  }
}

function leafKeys(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const here = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafKeys(v, here, out);
    else out.push(here);
  }
  return out;
}

/** Collapse plural variants to their base key for cross-locale comparison. */
function keyFamilies(obj) {
  return [...new Set(leafKeys(obj).map((k) => k.replace(PLURAL_SUFFIX, '')))].sort();
}

// PASS 1: merge and validate entirely in memory. Nothing touches disk here.
const pending = [];
const results = {};
let failed = false;

for (const file of dictFiles) {
  const locale = file.replace(/\.json$/, '');
  const path = join(LOCALES_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const dict = JSON.parse(raw);

  const collisions = [];
  mergeStrict(dict, fragments[locale], '', collisions);
  if (collisions.length) {
    console.error(`${locale}: refusing to overwrite existing keys: ${collisions.join(', ')}`);
    failed = true;
    continue;
  }

  const next = JSON.stringify(dict, null, detectIndent(raw)) + '\n';
  // Re-parse what we are about to write. A dictionary that does not round-trip
  // is the one failure mode worth paying an extra parse to rule out.
  JSON.parse(next);
  results[locale] = keyFamilies(dict);
  pending.push({ locale, path, raw, next });
}

if (failed) process.exit(1);

// Every dictionary must end up with the SAME key set. A locale quietly missing
// a key renders the raw key path to a user in that language, which nobody on an
// English-speaking team ever sees.
const reference = results.en;
let drift = false;
for (const [locale, keys] of Object.entries(results)) {
  const missingHere = reference.filter((k) => !keys.includes(k));
  const extraHere = keys.filter((k) => !reference.includes(k));
  if (missingHere.length || extraHere.length) {
    drift = true;
    console.error(`${locale}: key families differ from en`);
    if (missingHere.length) console.error(`  missing: ${missingHere.join(', ')}`);
    if (extraHere.length) console.error(`  extra:   ${extraHere.join(', ')}`);
  }
}
if (drift) process.exit(1);

// PASS 2: only now, with all 20 validated, write.
const written = [];
if (!checkOnly) {
  for (const { locale, path, raw, next } of pending) {
    if (next !== raw) {
      writeFileSync(path, next, 'utf8');
      written.push(locale);
    }
  }
}

console.log(
  checkOnly
    ? `OK: ${dictFiles.length} dictionaries parse and share ${reference.length} key families.`
    : `Spliced ${written.length} dictionaries. ${reference.length} key families, identical across all ${dictFiles.length}.`,
);
