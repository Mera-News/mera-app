// Self-test for move-module.ts and rewrite-barrel.ts: runs both against a copy of fixtures/ in a temp
// git repo and asserts the exact result. Never touches the app tree.
//   npx tsx scripts/codemods/selftest.ts
// Fixture files carry a `.fx` suffix so tsc, jest and eslint ignore them; it is stripped on copy.
import { execFileSync, spawnSync } from 'child_process';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const here = __dirname;
const MOVES = [{ from: 'lib/utils/time-ago.ts', to: 'lib/algorithms/time-ago.ts',
  test: { from: 'lib/utils/__tests__/time-ago.test.ts', to: 'lib/algorithms/__tests__/time-ago.test.ts' } }];

function copyTree(src: string, dst: string, rel = ''): void {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) copyTree(src, dst, r);
    else {
      const out = path.join(dst, r.replace(/\.fx$/, ''));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(path.join(src, r), out);
    }
  }
}

const made: string[] = [];

function fresh(extra: Record<string, string> = {}, moves: unknown = MOVES): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemods-'));
  made.push(dir);
  copyTree(path.join(here, 'fixtures'), dir);
  fs.writeFileSync(path.join(dir, 'moves.json'), JSON.stringify(moves));
  for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), t);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'fixture');
  return dir;
}

function run(tool: string, dir: string, ...args: string[]) {
  const r = spawnSync('npx', ['tsx', path.join(here, tool), '--root', dir, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

const snapshot = (dir: string) =>
  execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }) +
  execFileSync('git', ['diff'], { cwd: dir, encoding: 'utf8' });
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
let n = 0;
const ok = (name: string) => console.log(`ok ${++n} ${name}`);

// ---- move-module -------------------------------------------------------------------------------
{
  const d = fresh();
  const before = snapshot(d);
  let r = run('move-module.ts', d, '--list', 'moves.json', '--check');
  assert.equal(r.code, 0, r.out);
  assert.equal(snapshot(d), before, '--check must not touch the tree');
  assert.match(r.out, /git mv lib\/utils\/time-ago\.ts lib\/algorithms\/time-ago\.ts/);
  ok('move --check plans and writes nothing');

  r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(d, 'lib/utils/time-ago.ts')));
  assert.equal(read(d, 'lib/algorithms/time-ago.ts'),
    "import { helper } from '../utils/helper';\nimport { other } from '../other';\nimport { other as again } from '@/lib/other';\n\nexport const timeAgo = () => helper + other + again;\n");
  assert.equal(read(d, 'lib/algorithms/__tests__/time-ago.test.ts'),
    "import { timeAgo } from '../time-ago';\n\njest.mock('../../utils/helper');\n\ntest('x', () => expect(timeAgo).toBeDefined());\n");
  assert.equal(read(d, 'lib/importer-alias.ts'), [
    "import { timeAgo } from '@/lib/algorithms/time-ago';",
    'import type { timeAgo as T } from "@/lib/algorithms/time-ago";',
    "import { other } from '@/lib/other';",
    '',
    "export { timeAgo as again } from '@/lib/algorithms/time-ago';",
    "export const lazy = () => require('@/lib/algorithms/time-ago').timeAgo;",
    "export type Mod = typeof import('@/lib/algorithms/time-ago');",
    "export const dyn = () => import('@/lib/algorithms/time-ago');",
    "jest.mock('@/lib/other');",
    'export { timeAgo, T, other };',
    '',
  ].join('\n'));
  assert.equal(read(d, 'lib/sub/importer-rel.ts'),
    "import { timeAgo } from '../algorithms/time-ago';\nimport { helper } from '../utils/helper';\n\nexport const v = [timeAgo, helper];\n");
  assert.equal(read(d, 'harness-local/h.ts'), "import { timeAgo } from '../lib/algorithms/time-ago';\n\nconsole.log(timeAgo);\n");
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }), /RM lib\/utils\/time-ago\.ts -> lib\/algorithms\/time-ago\.ts/);
  ok('move rewrites alias, relative, require, typeof import, import(), re-export, moved files, harness-local');

  const after = snapshot(d);
  r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing to do/);
  assert.equal(snapshot(d), after);
  ok('move is idempotent');
}
{
  const d = fresh({ 'lib/mocker.ts': "jest.mock('@/lib/utils/time-ago');\njest.requireActual('../lib/utils/time-ago');\n" });
  const before = snapshot(d);
  const r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lib\/mocker\.ts:1: jest\.mock/);
  assert.match(r.out, /lib\/mocker\.ts:2: jest\.requireActual/);
  assert.equal(snapshot(d), before);
  ok('move refuses a mocked target (R10) and writes nothing');
}

// ---- move-module, per-name moves ---------------------------------------------------------------
const NAMES = [{ names: ['m1', 'm2', 'M3'], fromModule: 'lib/split/src.ts', toModule: 'lib/split/dest.ts' }];
{
  const d = fresh({}, NAMES);
  const before = snapshot(d);
  let r = run('move-module.ts', d, '--list', 'moves.json', '--check');
  assert.equal(r.code, 0, r.out);
  assert.equal(snapshot(d), before);
  r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 0, r.out);
  assert.equal(read(d, 'lib/split-users.ts'), [
    "import { kept } from '@/lib/split/src';",
    "import { m1 } from '@/lib/split/dest';",
    "import { m2 as two } from './split/dest';",
    "import type { KeptT } from '@/lib/split/src';",
    "import type { M3 } from '@/lib/split/dest';",
    "import { kept as k2 } from './split/src';",
    '',
    "export { kept as rk } from '@/lib/split/src';",
    "export { m1 as r1 } from '@/lib/split/dest';",
    "export type Q = typeof import('@/lib/split/dest').m1;",
    'export { m1, kept, two, k2 };',
    'export type { M3, KeptT };',
    '',
  ].join('\n'));
  assert.equal(read(d, 'lib/split-merge.ts'),
    "import { x, m1 } from './split/dest';\nimport type { M3 } from './split/dest';\n\nexport { x, m1 };\nexport type { M3 };\n");
  ok('names move splits named, aliased, type-only and mixed imports, merges into an existing import');

  const after = snapshot(d);
  r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 0, r.out);
  assert.equal(snapshot(d), after);
  assert.match(r.out, /rewrite 0|rewrote 0/);
  ok('names move is idempotent');
}
for (const [what, file, re] of [
  ['namespace import', "import * as ns from '@/lib/split/src';\nexport const v = ns.m1;\n", /namespace import/],
  ['require', "export const v = require('@/lib/split/src').m2;\n", /require\('@\/lib\/split\/src'\)/],
] as const) {
  const d = fresh({ 'lib/hand.ts': file }, NAMES);
  const before = snapshot(d);
  const r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, re);
  assert.match(r.out, /lib\/hand\.ts:1/);
  assert.equal(snapshot(d), before);
  ok(`names move lists a ${what} using a moved name and writes nothing`);
}
{
  const d = fresh({ 'lib/ok.ts': "import * as ns from '@/lib/split/src';\nexport const v = ns.kept;\n" }, NAMES);
  assert.equal(run('move-module.ts', d, '--list', 'moves.json').code, 0);
  ok('names move leaves a namespace import that only uses kept names');
}
{
  const d = fresh({ 'lib/mocker.ts': "jest.mock('@/lib/split/src');\n" }, NAMES);
  const before = snapshot(d);
  const r = run('move-module.ts', d, '--list', 'moves.json');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lib\/mocker\.ts:1: jest\.mock/);
  assert.equal(snapshot(d), before);
  ok('names move refuses a mocked fromModule (R10)');
}
// ---- rewrite-barrel ----------------------------------------------------------------------------
{
  const d = fresh();
  const before = snapshot(d);
  let r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts', '--check', '--delete');
  assert.equal(r.code, 0, r.out);
  assert.equal(snapshot(d), before, '--check must not touch the tree');
  ok('barrel --check plans and writes nothing');

  r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts');
  assert.equal(r.code, 0, r.out);
  assert.equal(read(d, 'lib/barrel-users.ts'), [
    "import { a, b as c } from '@/lib/barrel/a';",
    "import { d } from '@/lib/barrel/b';",
    "import { e } from '@/lib/barrel/deep';",
    "import { type T } from '@/lib/barrel/types';",
    "import type { T as T2 } from './barrel/types';",
    "import { a as onlyA } from '@/lib/barrel/a';",
    "import { default as Dflt, a as a3 } from '@/lib/barrel/a';",
    '',
    "export { d as dd } from '@/lib/barrel/b';",
    "export { e as ee } from '@/lib/barrel/deep';",
    "export { a, b as c } from './barrel/a';",
    "export { default as Dflt } from './barrel/a';",
    "export * from './barrel/b';",
    "export type { T } from './barrel/types';",
    "export const lazyA = () => require('@/lib/barrel/a').a;",
    "export const { a: aa } = require('@/lib/barrel/a');",
    "export type TT = typeof import('@/lib/barrel/types').T;",
    'export { a, c, d, e, T, T2, onlyA, Dflt, a3 };',
    '',
  ].join('\n'));
  ok('barrel splits by defining module, keeps aliases and type, follows export * chain, rewrites require and typeof import');

  const after = snapshot(d);
  r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /rewrote 0 importer/);
  assert.equal(snapshot(d), after);
  ok('barrel is idempotent');

  r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts', '--delete');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(d, 'lib/barrel/index.ts')));
  ok('barrel --delete removes it once no importer is left');
}
{
  // a single `export *` barrel: any importer form, including a whole-module require
  const d = fresh({
    'lib/barrel/index.ts': "export * from './deep';\n",
    'lib/whole.ts': "export const m = () => require('@/lib/barrel');\nexport * as ns from './barrel';\n",
  });
  const r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts');
  assert.equal(r.code, 0, r.out);
  assert.equal(read(d, 'lib/whole.ts'), "export const m = () => require('@/lib/barrel/deep');\nexport * as ns from './barrel/deep';\n");
  ok('single export * barrel rewrites every importer form');
}
{
  const d = fresh();
  const before = snapshot(d);
  const r = run('rewrite-barrel.ts', d, '--barrel', 'lib/bad/index.ts');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not a re-export \(R9\)/);
  assert.equal(snapshot(d), before);
  ok('side-effect barrel refused');
}
{
  const d = fresh({ 'lib/mocker.ts': "jest.mock('@/lib/barrel');\n" });
  const before = snapshot(d);
  let r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /lib\/mocker\.ts:1: jest\.mock/);
  assert.equal(snapshot(d), before);
  ok('mocked barrel refused (R10)');

  fs.writeFileSync(path.join(d, 'lib/mocker.ts'), "import * as all from '@/lib/barrel';\nexport { all };\n");
  r = run('rewrite-barrel.ts', d, '--barrel', 'lib/barrel/index.ts');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /namespace import/);
  ok('namespace import of a multi-source barrel refused');
}
for (const d of made) fs.rmSync(d, { recursive: true, force: true });
console.log(`all ${n} ok`);
