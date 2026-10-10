// The circular-import gate (R83): no module newly in a cycle and no new cycle, between two revisions.
//   npx tsx scripts/codemods/cycles.ts --base <rev> [--head <rev>] [--root <dir>]   (head defaults to the working tree)
//
// madge's chain count is not a usable gate: it lists one chain per DFS back edge, so splitting a module
// that already sits in a cycle reports more chains for the same cycle. This compares strongly
// connected components of the runtime import graph instead. A file that is new in head is judged
// through its SCC: it may join a cycle that already existed (a split of a cyclic module), but an SCC
// none of whose files was cyclic in base is a NEW cycle. Renames between base and head are followed.
// Runtime edges only: value imports, re-exports and require(); type-only imports, import() and jest.*
// strings are not load-time dependencies. Nodes: source files under app/, components/, lib/, modules/,
// tests excluded. Exit 1 on any violation, listing it.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { DEFAULT_ROOT, findRefs, parse, parseArgs, resolveSpec, walkFiles } from './lib';

const NODE_DIRS = /^(app|components|lib|modules)\//;
const isTest = (f: string) => /(^|\/)__tests__\//.test(f) || /\.test\.[jt]sx?$/.test(f);

function isTypeOnly(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const c = node.importClause;
    if (!c) return false; // side-effect import: runtime
    if (c.isTypeOnly) return true;
    const nb = c.namedBindings;
    return !c.name && !!nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((e) => e.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  return false;
}

/** Runtime import graph of the tree at `root`: file -> files it loads. */
export function importGraph(root: string): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  const files = walkFiles(root).filter((f) => NODE_DIRS.test(f) && !isTest(f));
  for (const f of files) {
    const out = new Set<string>();
    const { sf } = parse(root, f);
    for (const r of findRefs(sf)) {
      if (r.kind !== 'import' && r.kind !== 'export' && r.kind !== 'require') continue;
      if (isTypeOnly(r.node)) continue;
      const t = resolveSpec(root, f, r.spec);
      if (t && t !== f && NODE_DIRS.test(t) && !isTest(t)) out.add(t);
    }
    g.set(f, out);
  }
  return g;
}

/** Strongly connected components with more than one member (Tarjan, iterative). */
export function cycles(g: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let i = 0;
  for (const start of g.keys()) {
    if (index.has(start)) continue;
    const work: [string, string[]][] = [[start, [...(g.get(start) ?? [])]]];
    index.set(start, i); low.set(start, i); i++; stack.push(start); onStack.add(start);
    while (work.length) {
      const [v, todo] = work[work.length - 1];
      const w = todo.shift();
      if (w !== undefined) {
        if (!g.has(w)) continue;
        if (!index.has(w)) {
          index.set(w, i); low.set(w, i); i++; stack.push(w); onStack.add(w);
          work.push([w, [...(g.get(w) ?? [])]]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = [];
        let x: string;
        do { x = stack.pop()!; onStack.delete(x); comp.push(x); } while (x !== v);
        if (comp.length > 1) out.push(comp.sort());
      }
    }
  }
  return out;
}

export interface CycleReport { baseCyclic: number; headCyclic: number; baseSccs: number; headSccs: number; violations: string[] }

/** Compare base and head cycles. `renamed` maps a head path to its base path. */
export function compare(base: Map<string, Set<string>>, head: Map<string, Set<string>>, renamed: Map<string, string>): CycleReport {
  const bs = cycles(base);
  const hs = cycles(head);
  const baseCyclic = new Set(bs.flat());
  const inBase = (f: string) => base.has(renamed.get(f) ?? f);
  const toBase = (f: string) => renamed.get(f) ?? f;
  const violations: string[] = [];
  for (const comp of hs) {
    const known = comp.filter(inBase);
    const newlyCyclic = known.filter((f) => !baseCyclic.has(toBase(f)));
    for (const f of newlyCyclic) violations.push(`newly in a cycle: ${f}`);
    if (!known.some((f) => baseCyclic.has(toBase(f)))) {
      violations.push(`new cycle (no member was cyclic in base): ${comp.join(' <-> ')}`);
    }
  }
  return { baseCyclic: baseCyclic.size, headCyclic: new Set(hs.flat()).size, baseSccs: bs.length, headSccs: hs.length, violations };
}

function treeAt(root: string, rev: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycles-'));
  const tar = execFileSync('git', ['archive', rev], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 30 });
  return dir;
}

function renames(root: string, base: string, head?: string): Map<string, string> {
  const args = ['diff', '-M50%', '--name-status', '--diff-filter=R', base, ...(head ? [head] : []), '--', '.'];
  const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [, from, to] = line.split('\t');
    if (from && to) map.set(to, from);
  }
  return map;
}

if (require.main === module) {
  const { vals } = parseArgs(process.argv.slice(2), ['--base', '--head', '--root']);
  const root = path.resolve(vals['--root'] ?? DEFAULT_ROOT);
  if (!vals['--base']) {
    console.error('usage: npx tsx scripts/codemods/cycles.ts --base <rev> [--head <rev>] [--root <dir>]');
    process.exit(2);
  }
  const made: string[] = [];
  try {
    const baseDir = treeAt(root, vals['--base']);
    made.push(baseDir);
    const headDir = vals['--head'] ? treeAt(root, vals['--head']) : root;
    if (vals['--head']) made.push(headDir);
    const r = compare(importGraph(baseDir), importGraph(headDir), renames(root, vals['--base'], vals['--head']));
    console.log(`cyclic modules ${r.baseCyclic} -> ${r.headCyclic}, cycles (SCCs) ${r.baseSccs} -> ${r.headSccs}`);
    if (r.violations.length) {
      console.error(`${r.violations.length} violation(s):`);
      for (const v of r.violations) console.error(`  ${v}`);
      process.exit(1);
    }
    console.log('ok: no module newly in a cycle, no new cycle');
  } finally {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }
}
