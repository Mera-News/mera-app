#!/usr/bin/env node
// DELETE named key paths from all 20 locale dictionaries.
//
//   node lib/locales/_drop-keys.mjs --check <dotted.key.path> [...]
//   node lib/locales/_drop-keys.mjs         <dotted.key.path> [...]
//
// The mirror of `_splice-fragments.mjs`, which only ADDS. It exists for the
// same reason that one does: hand-editing the dictionaries, or fanning the
// edit out one file per agent, corrupted four of them in an earlier wave.
// Removing a key is a mechanical operation on 20 files and belongs in a script
// that either does all 20 identically or refuses.
//
// Guarantees, all enforced below rather than assumed, and all three are the
// ones that actually broke a dictionary before:
//   - Non-ASCII is written through VERBATIM. `JSON.stringify` does not escape
//     it; the equivalent in another language usually does by default, and an
//     escaped round trip is exactly how ar/hi/ja/zh got mangled.
//   - Indentation is DETECTED per file, never assumed. Hardcoding it rewrites
//     every line of every dictionary, and a real one-key diff buried in a
//     whole-file reformat is unreviewable.
//   - NOTHING is written until every locale has been read, parsed and had
//     every path resolved. A failure partway must leave 20 clean files.
//
// A path ABSENT from a locale is reported and counted, not an error: the
// dictionaries drift, and refusing the whole run over one missing key would
// mean the other nineteen keep a string that no longer has a reader.
//
// A deleted key leaves no fragment behind, so there is nothing to commit
// alongside it the way an ADD leaves a `_*-fragments.json`. Name the dropped
// paths in the commit message instead; that is the only record.

import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve('lib/locales');
const args = process.argv.slice(2);
const check = args.includes('--check');
const paths = args.filter((a) => a !== '--check');

if (paths.length === 0) {
  console.error('usage: node lib/locales/_drop-keys.mjs [--check] <dotted.key.path> [...]');
  console.error('run from the mera-app/ root, the same as _splice-fragments.mjs');
  process.exit(2);
}

// `_`-prefixed files are fragments and this script; they are not dictionaries.
const files = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

if (files.length !== 20) {
  console.error(`expected 20 dictionaries in ${LOCALES_DIR}, found ${files.length}`);
  process.exit(1);
}

/** The file's own indentation, read off its first indented key. */
function detectIndent(text) {
  const m = text.match(/\n([ \t]+)"/);
  return m ? m[1] : '  ';
}

const planned = [];
let missing = 0;

for (const file of files) {
  const full = path.join(LOCALES_DIR, file);
  const text = fs.readFileSync(full, 'utf8');
  const data = JSON.parse(text);
  const indent = detectIndent(text);
  const removed = [];

  for (const p of paths) {
    const segs = p.split('.');
    let node = data;
    let ok = true;
    for (const s of segs.slice(0, -1)) {
      if (node && typeof node === 'object' && s in node) node = node[s];
      else {
        ok = false;
        break;
      }
    }
    const last = segs[segs.length - 1];
    if (ok && node && typeof node === 'object' && last in node) {
      delete node[last];
      removed.push(p);
    } else {
      console.log(`  ~ ${file}: ${p} absent`);
      missing += 1;
    }
  }

  const trailing = text.endsWith('\n') ? '\n' : '';
  planned.push({ full, file, body: JSON.stringify(data, null, indent) + trailing, removed });
}

for (const p of planned) {
  console.log(`${check ? 'would drop' : 'dropped'} ${p.removed.length} from ${p.file}`);
}

if (check) {
  console.log(`\n--check only, nothing written. ${missing} absent path(s) across 20 files.`);
  process.exit(0);
}

for (const p of planned) fs.writeFileSync(p.full, p.body, 'utf8');
console.log(`\nwrote 20 files. ${missing} absent path(s).`);
