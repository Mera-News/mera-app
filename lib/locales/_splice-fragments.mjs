#!/usr/bin/env node
// Splice a fragment file into the 20 locale dictionaries.
//
//   node lib/locales/_splice-fragments.mjs lib/locales/_intercom-fragments.json
//   node lib/locales/_splice-fragments.mjs <fragments.json> --check
//
// To knowingly retranslate keys that already exist (not just add new ones),
// name them explicitly:
//
//   node lib/locales/_splice-fragments.mjs <fragments.json> \
//     --allow-overwrite factCheck.checkedByHeading,factCheck.disclaimer
//
// A key named in `--allow-overwrite` has its collision turned into a
// permitted overwrite; every OTHER collision still hard-fails the whole run,
// exactly as with no flag at all. `--check` reports allowed overwrites in
// their own section, separate from the pass/fail collision list, so a
// reviewer can see WHAT would change before anything is written. The flag is
// a durable, explicit escape hatch, not a loosening of the default contract —
// omit it and the script refuses every collision precisely as before.
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
//   - Existing keys are never overwritten UNLESS explicitly named via
//     `--allow-overwrite`. A collision on any other key is an error, not a
//     merge, in every mode including with the flag set.
//   - Key ORDER is preserved for existing namespaces; new keys append. An
//     overwrite replaces a value in place and never moves it.
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

const overwriteFlagIndex = process.argv.indexOf('--allow-overwrite');
if (overwriteFlagIndex !== -1 && !process.argv[overwriteFlagIndex + 1]) {
  console.error('--allow-overwrite requires a comma-separated list of dot.path.key values');
  process.exit(2);
}
// Dot-path keys (e.g. "factCheck.disclaimer") permitted to overwrite an
// EXISTING value. Everything else still collides exactly as before — this
// set only narrows what is allowed, it never widens what is refused.
const allowOverwrite = new Set(
  overwriteFlagIndex === -1
    ? []
    : process.argv[overwriteFlagIndex + 1].split(',').map((s) => s.trim()).filter(Boolean),
);

if (!fragmentsPath) {
  console.error('usage: _splice-fragments.mjs <fragments.json> [--check] [--allow-overwrite k1,k2,...]');
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

/**
 * Merge `src` into `dst`. A leaf collision is refused UNLESS its dot-path is
 * named in `allowOverwrite`, in which case it is recorded in `overwrites`
 * (old value, new value) and applied. A STRUCTURAL collision (an existing
 * object being replaced by a non-object or vice versa) is never overwritable
 * through this mechanism, regardless of `allowOverwrite` — that shape change
 * is a different, much larger blast radius than "retranslate one string",
 * and nothing has asked for it.
 */
function mergeStrict(dst, src, path, collisions, overwrites, allowOverwrite) {
  for (const [key, value] of Object.entries(src)) {
    const here = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (dst[key] === undefined) dst[key] = {};
      else if (typeof dst[key] !== 'object' || Array.isArray(dst[key])) {
        collisions.push(`${here} (existing value is not an object)`);
        continue;
      }
      mergeStrict(dst[key], value, here, collisions, overwrites, allowOverwrite);
    } else if (dst[key] !== undefined) {
      if (dst[key] !== value) {
        if (allowOverwrite.has(here)) {
          overwrites.push({ key: here, from: dst[key], to: value });
          dst[key] = value;
        } else {
          collisions.push(here);
        }
      }
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
const allOverwrites = [];
let failed = false;

for (const file of dictFiles) {
  const locale = file.replace(/\.json$/, '');
  const path = join(LOCALES_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const dict = JSON.parse(raw);

  const collisions = [];
  const overwrites = [];
  mergeStrict(dict, fragments[locale], '', collisions, overwrites, allowOverwrite);
  if (collisions.length) {
    console.error(`${locale}: refusing to overwrite existing keys: ${collisions.join(', ')}`);
    failed = true;
    continue;
  }
  if (overwrites.length) allOverwrites.push({ locale, overwrites });

  const next = JSON.stringify(dict, null, detectIndent(raw)) + '\n';
  // Re-parse what we are about to write. A dictionary that does not round-trip
  // is the one failure mode worth paying an extra parse to rule out.
  JSON.parse(next);
  results[locale] = keyFamilies(dict);
  pending.push({ locale, path, raw, next });
}

if (failed) process.exit(1);

// Allowed overwrites are reported on their own, distinct from the collision
// list above — a reviewer needs to see WHAT would change under
// --allow-overwrite before anything is written, not just that nothing
// collided.
if (allOverwrites.length) {
  console.log(`Allowed overwrites (${allOverwrites.reduce((n, { overwrites }) => n + overwrites.length, 0)} total):`);
  for (const { locale, overwrites } of allOverwrites) {
    for (const { key, from, to } of overwrites) {
      console.log(`  ${locale}: ${key}`);
      console.log(`    - ${JSON.stringify(from)}`);
      console.log(`    + ${JSON.stringify(to)}`);
    }
  }
}

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
