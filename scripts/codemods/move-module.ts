// move-module: move files and rewrite every specifier that points at them.
//
//   npx tsx scripts/codemods/move-module.ts --list scripts/codemods/moves.json [--check] [--root <dir>]
//
// moves.json is a JSON array. Every area appends entries; do not reformat it.
//   { "from": "lib/utils/time-ago.ts", "to": "lib/algorithms/time-ago.ts",
//     "test": { "from": "lib/utils/__tests__/time-ago.test.ts", "to": "lib/algorithms/__tests__/time-ago.test.ts" } }
// "test" is optional. An entry may be test-only: { "test": { "from": ..., "to": ... } }.
// Paths are POSIX, relative to the app root. An entry with a "_format" key is documentation, skipped.
//
// Rewrites static import/export-from, require(), import(), typeof import() and jest.* specifiers that
// resolve to a moved file (alias `@/` stays `@/`, relative stays relative), and the relative specifiers
// inside the moved files themselves. Lazy require() stays lazy: only the string changes (R11).
// R10: exits 1, writing nothing, if jest.mock/doMock/requireActual names a moved file.
// R4: only specifier strings change, in harness-local/ and eval/ too.
// Idempotent: an entry whose `from` is gone and `to` exists is skipped. --check changes nothing.
import * as fs from 'fs';
import * as path from 'path';
import { planNameMoves, NameMove, NamePlan } from './move-names';
import {
  applyEdits, DEFAULT_ROOT, Edit, findRefs, formatSpec, git, MOCK_REFUSE, parse, parseArgs,
  resolveSpec, walkFiles,
} from './lib';

interface Pair { from: string; to: string }
interface Entry { _format?: string; from?: string; to?: string; test?: Pair; names?: string[]; fromModule?: string; toModule?: string }

const { flags, vals } = parseArgs(process.argv.slice(2), ['--list', '--root']);
const root = vals['--root'] ? path.resolve(vals['--root']) : DEFAULT_ROOT;
const check = flags.has('--check');
const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!vals['--list']) die('usage: move-module.ts --list <moves.json> [--check] [--root <dir>]');

const entries: Entry[] = JSON.parse(fs.readFileSync(path.resolve(root, vals['--list']), 'utf8'));
const pairs: Pair[] = [];
const nameMoves: NameMove[] = [];
for (const e of entries) {
  if (e._format) continue;
  if (e.names) {
    if (!e.fromModule || !e.toModule || !e.names.length) die(`names entry needs names, fromModule, toModule: ${JSON.stringify(e)}`);
    nameMoves.push({ names: e.names, fromModule: e.fromModule!, toModule: e.toModule! });
    continue;
  }
  if (e.from || e.to) {
    if (!e.from || !e.to) die(`entry needs both from and to: ${JSON.stringify(e)}`);
    pairs.push({ from: e.from!, to: e.to! });
  }
  if (e.test) pairs.push(e.test);
  if (!e.from && !e.to && !e.test) die(`empty entry: ${JSON.stringify(e)}`);
}
const seen = new Set<string>();
for (const p of pairs) {
  for (const f of [p.from, p.to]) {
    if (f.startsWith('/') || f.includes('..')) die(`path must be relative to the root: ${f}`);
  }
  if (seen.has(p.from) || seen.has(p.to)) die(`duplicate path in the list: ${p.from} / ${p.to}`);
  seen.add(p.from);
  seen.add(p.to);
}

const moveMap = new Map<string, string>();
for (const p of pairs) {
  const f = fs.existsSync(path.join(root, p.from));
  const t = fs.existsSync(path.join(root, p.to));
  if (f && t) die(`both exist, resolve by hand: ${p.from} -> ${p.to}`);
  if (!f && !t) die(`neither exists: ${p.from} -> ${p.to}`);
  if (f) moveMap.set(p.from, p.to);
}
for (const nm of nameMoves) {
  if (moveMap.has(nm.fromModule) || moveMap.has(nm.toModule)) die(`do not combine a file move and a names move on ${nm.fromModule} / ${nm.toModule}`);
}
if (moveMap.size === 0 && nameMoves.length === 0) {
  console.log('nothing to do: every entry is already moved');
  process.exit(0);
}

const files = walkFiles(root);
const refused: string[] = [];
const warnings: string[] = [];
const edits = new Map<string, Edit[]>();
const log: string[] = [];
let specCount = 0;

for (const f of files) {
  const newF = moveMap.get(f) ?? f;
  const { sf } = parse(root, f);
  for (const ref of findRefs(sf)) {
    const target = resolveSpec(root, f, ref.spec);
    if (!target) {
      if (newF !== f && ref.spec.startsWith('.')) {
        warnings.push(`${f}:${ref.line}: unresolved relative '${ref.spec}' in a moved file, left as is`);
      }
      continue;
    }
    if (ref.kind === 'mock' && MOCK_REFUSE.has(ref.fn!) && moveMap.has(target)) {
      refused.push(`${f}:${ref.line}: jest.${ref.fn}('${ref.spec}') names moved file ${target}`);
      continue;
    }
    const newT = moveMap.get(target) ?? target;
    const relativeAndImporterMoved = newF !== f && !ref.spec.startsWith('@/');
    if (newT === target && !relativeAndImporterMoved) continue;
    const next = formatSpec(ref.spec, newT, newF);
    if (next === ref.spec) continue;
    if (!edits.has(f)) edits.set(f, []);
    edits.get(f)!.push({ start: ref.start, end: ref.end, text: next });
    log.push(`${f}:${ref.line}: '${ref.spec}' -> '${next}'`);
    specCount++;
  }
}

let plan: NamePlan = { edits: new Map(), log: [], refused: [], unresolved: [] };
try {
  plan = planNameMoves(root, files, nameMoves);
} catch (err) {
  die((err as Error).message);
}
refused.push(...plan.refused);
if (plan.unresolved.length) {
  console.error(`${plan.unresolved.length} importer(s) need a hand edit, nothing written:`);
  for (const u of plan.unresolved) console.error(`  ${u}`);
  if (!refused.length) process.exit(1);
}
if (refused.length) {
  console.error(`R10: ${refused.length} mock(s) name a moved file, nothing written:`);
  for (const r of refused) console.error(`  ${r}`);
  process.exit(1);
}
for (const [f, es] of plan.edits) {
  edits.set(f, [...(edits.get(f) ?? []), ...es]);
}
specCount += plan.log.length;
log.push(...plan.log);
for (const w of warnings) console.error(`warning: ${w}`);
for (const [from, to] of moveMap) log.push(`git mv ${from} ${to}`);
console.log(log.join('\n'));

if (!check) {
  for (const [f, es] of edits) {
    const abs = path.join(root, f);
    fs.writeFileSync(abs, applyEdits(fs.readFileSync(abs, 'utf8'), es));
  }
  for (const [from, to] of moveMap) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    git(root, ['mv', from, to]);
  }
}
console.log(
  `${check ? 'check: would move' : 'moved'} ${moveMap.size} file(s), ` +
    `${check ? 'rewrite' : 'rewrote'} ${specCount} specifier(s) in ${edits.size} file(s)`,
);
