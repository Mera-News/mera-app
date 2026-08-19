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
//   - The key-family drift check is a DELTA gate, not an absolute one. A
//     locale's key families (i18next plural suffixes collapsed, so Arabic's
//     six forms and Chinese's one are never drift on their own) are snapshotted
//     against en BEFORE this run's merge, and again AFTER. Drift that is NEW
//     in the after-snapshot — a family this run's fragment made appear or
//     disappear relative to en — hard-fails exactly as an absolute check
//     would. Drift that was ALREADY there before this run touched anything is
//     printed as a warning (per locale, counts and the key-family names) and
//     does NOT fail. The old absolute gate asserted "the dictionaries are
//     drift-free", which was already false the moment any wave shipped an
//     en-only key and moved on to translate it later — that made the tool
//     unusable for any run after the first pre-existing gap. The delta gate
//     asserts the thing a single splice can actually promise: "this run did
//     not make it worse." `--check` classifies drift identically to write
//     mode, new vs pre-existing, so a reviewer sees the same picture either way.
//   - A fragment key containing a literal "." is rejected before anything
//     merges, in every locale, for the whole fragment. This repo's
//     dictionaries always nest; a flattened "a.b.c" string as a key name is
//     invariably a mistake, not a real key — merged as-is it would silently
//     create a bogus new top-level entry instead of touching the real nested
//     value, corrupting the dictionary without ever raising an error. This
//     happened to a real fragment batch once; it is now a hard, early failure
//     instead of a silent one.
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

/** Every dot-path key a fragment object contains, wherever it appears — not
 *  the dictionary, the FRAGMENT. A key name with a literal "." in it is
 *  always a flattened path mistake here; see the file header. */
function findDottedKeys(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const here = prefix ? `${prefix}.${k}` : k;
    if (k.includes('.')) out.push(here);
    if (v && typeof v === 'object' && !Array.isArray(v)) findDottedKeys(v, here, out);
  }
  return out;
}

const malformed = fragmentLocales
  .map((locale) => ({ locale, dotted: findDottedKeys(fragments[locale]) }))
  .filter(({ dotted }) => dotted.length);

if (malformed.length) {
  console.error(
    'Malformed dot-path fragment: a key contains a literal "." — every dictionary '
    + 'here nests, so this is a flattened path used as a key name, not a real key. '
    + 'Reshape it into nested objects before splicing.',
  );
  for (const { locale, dotted } of malformed) {
    console.error(`  ${locale}: ${dotted.join(', ')}`);
  }
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
const beforeResults = {};
const results = {};
const allOverwrites = [];
let failed = false;

for (const file of dictFiles) {
  const locale = file.replace(/\.json$/, '');
  const path = join(LOCALES_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const dict = JSON.parse(raw);

  // BEFORE snapshot — key families as they stand right now, untouched. Taken
  // ahead of the merge below, which mutates `dict` in place.
  beforeResults[locale] = keyFamilies(dict);

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

// DELTA drift gate — see the file header for why this is not an absolute
// check. A locale quietly missing a key this run was supposed to add renders
// the raw key path to a user in that language, which nobody on an
// English-speaking team ever sees; that is what this still catches. A gap
// that predates this run and this run did not touch is a separate, already
// pre-existing problem this run did not create and cannot fix by refusing to
// ship anything at all.
const beforeReference = beforeResults.en;
const afterReference = results.en;
let newDrift = false;
const staleWarnings = [];

for (const [locale, afterKeys] of Object.entries(results)) {
  const afterMissing = afterReference.filter((k) => !afterKeys.includes(k));
  const afterExtra = afterKeys.filter((k) => !afterReference.includes(k));

  const beforeKeys = beforeResults[locale];
  const beforeMissing = beforeReference.filter((k) => !beforeKeys.includes(k));
  const beforeExtra = beforeKeys.filter((k) => !beforeReference.includes(k));

  const newMissing = afterMissing.filter((k) => !beforeMissing.includes(k));
  const newExtra = afterExtra.filter((k) => !beforeExtra.includes(k));
  const staleMissing = afterMissing.filter((k) => beforeMissing.includes(k));
  const staleExtra = afterExtra.filter((k) => beforeExtra.includes(k));

  if (newMissing.length || newExtra.length) {
    newDrift = true;
    console.error(`${locale}: NEW key-family drift introduced by this run`);
    if (newMissing.length) console.error(`  missing: ${newMissing.join(', ')}`);
    if (newExtra.length) console.error(`  extra:   ${newExtra.join(', ')}`);
  }
  if (staleMissing.length || staleExtra.length) {
    staleWarnings.push({ locale, staleMissing, staleExtra });
  }
}
if (newDrift) process.exit(1);

if (staleWarnings.length) {
  const totalStale = staleWarnings.reduce(
    (n, { staleMissing, staleExtra }) => n + staleMissing.length + staleExtra.length,
    0,
  );
  console.log(
    `Pre-existing drift, unchanged by this run (${totalStale} key families across `
    + `${staleWarnings.length} locales) — not this run's to fix, not blocking:`,
  );
  for (const { locale, staleMissing, staleExtra } of staleWarnings) {
    console.log(`  ${locale}: ${staleMissing.length + staleExtra.length} pre-existing`);
    if (staleMissing.length) console.log(`    missing: ${staleMissing.join(', ')}`);
    if (staleExtra.length) console.log(`    extra:   ${staleExtra.join(', ')}`);
  }
}

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
    ? `OK: ${dictFiles.length} dictionaries parse, en has ${afterReference.length} key families, `
      + `no NEW drift introduced.`
    : `Spliced ${written.length} dictionaries. ${afterReference.length} key families in en, `
      + `no NEW drift introduced across all ${dictFiles.length}.`,
);
