// rewrite-barrel: point every importer of a pure re-export barrel at the modules that define the names.
//
//   npx tsx scripts/codemods/rewrite-barrel.ts --barrel <path> [--check] [--delete] [--root <dir>]
//
// The barrel may contain only `export { a, b as c } from`, `export type { T } from` and `export * from`
// statements (R9). Exits 1, writing nothing, if it has any other statement, re-exports a package, uses
// `export * as ns`, if jest.mock/doMock/requireActual names it (R10), or if an importer cannot be
// rewritten by name (namespace import, side-effect import, whole-module require of a multi-source
// barrel). Imports stay named, one import is split into several when names come from different
// modules, aliases and `type` modifiers are kept, `export *` is followed through the barrel's chain.
// A barrel that is exactly one `export * from './x'` is replaced by './x' in every importer, any form.
// --delete removes the barrel (git rm) only when no importer is left. --check changes nothing.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  applyEdits, DEFAULT_ROOT, Edit, emitStatement, findRefs, formatSpec, git, MOCK_REFUSE, parse, parseArgs,
  resolveSpec, Style, styleOf, walkFiles,
} from './lib';

const { flags, vals } = parseArgs(process.argv.slice(2), ['--barrel', '--root']);
const root = vals['--root'] ? path.resolve(vals['--root']) : DEFAULT_ROOT;
const check = flags.has('--check');
const del = flags.has('--delete');
const die = (msgs: string[]): never => {
  console.error(msgs.join('\n'));
  process.exit(1);
};
if (!vals['--barrel']) die(['usage: rewrite-barrel.ts --barrel <path> [--check] [--delete] [--root <dir>]']);
const barrel = vals['--barrel'].replace(/^\.\//, '');

if (!fs.existsSync(path.join(root, barrel))) {
  console.log(`${barrel} does not exist: nothing to do`);
  process.exit(0);
}

// ---- read the barrel ---------------------------------------------------------------------------
interface Named { orig: string; module: string }
const named = new Map<string, Named>();
const stars: string[] = [];
const barrelDecls: { decl: ts.ExportDeclaration; module: string }[] = [];
const problems: string[] = [];
{
  const { sf } = parse(root, barrel);
  for (const st of sf.statements) {
    const where = `${barrel}:${sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1}`;
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) {
      problems.push(`${where}: not a re-export (R9): ${st.getText(sf).split('\n')[0]}`);
      continue;
    }
    if (st.exportClause && ts.isNamespaceExport(st.exportClause)) {
      problems.push(`${where}: export * as ${st.exportClause.name.text} cannot be rewritten by name`);
      continue;
    }
    const module = resolveSpec(root, barrel, st.moduleSpecifier.text);
    if (!module) {
      problems.push(`${where}: '${st.moduleSpecifier.text}' does not resolve to a file in the app`);
      continue;
    }
    barrelDecls.push({ decl: st, module });
    if (!st.exportClause) stars.push(module);
    else {
      for (const el of st.exportClause.elements) {
        named.set(el.name.text, { orig: (el.propertyName ?? el.name).text, module });
      }
    }
  }
}
if (problems.length) die([`${barrel} is not a pure re-export barrel:`, ...problems.map((p) => `  ${p}`)]);

/** True if the barrel is exactly one `export * from`, so any use of it equals a use of that module. */
const singleStar = barrelDecls.length === 1 && stars.length === 1;

const DECL_WITH_NAME = [
  ts.isFunctionDeclaration, ts.isClassDeclaration, ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration, ts.isEnumDeclaration, ts.isModuleDeclaration,
];

/** Find the module that defines `name` when re-exported through `mod`, following re-export chains. */
function definedIn(mod: string, name: string, visited = new Set<string>()): { module: string; orig: string } | null {
  if (visited.has(mod)) return null;
  visited.add(mod);
  const { sf } = parse(root, mod);
  const starFrom: string[] = [];
  const here = { module: mod, orig: name };
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (exported && isDefault && name === 'default') return here;
    if (exported && !isDefault) {
      if (ts.isVariableStatement(st)) {
        const names: string[] = [];
        const collect = (b: ts.BindingName) => {
          if (ts.isIdentifier(b)) names.push(b.text);
          else b.elements.forEach((el) => ts.isBindingElement(el) && collect(el.name));
        };
        st.declarationList.declarations.forEach((d) => collect(d.name));
        if (names.includes(name)) return here;
      } else if (
        DECL_WITH_NAME.some((is) => is(st)) &&
        (st as ts.FunctionDeclaration).name?.getText(sf) === name
      ) return here;
    }
    if (ts.isExportAssignment(st) && !st.isExportEquals && name === 'default') return here;
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const target = spec ? resolveSpec(root, mod, spec) : null;
      if (!st.exportClause) {
        if (target) starFrom.push(target);
      } else if (ts.isNamedExports(st.exportClause)) {
        const el = st.exportClause.elements.find((x) => x.name.text === name);
        if (el) {
          const orig = (el.propertyName ?? el.name).text;
          return target ? definedIn(target, orig, visited) : { module: mod, orig };
        }
      }
    }
  }
  for (const t of starFrom) {
    const r = definedIn(t, name, visited);
    if (r) return r;
  }
  return null;
}

function lookup(name: string): { module: string; orig: string } | null {
  const n = named.get(name);
  if (n) return n;
  for (const s of stars) {
    const r = definedIn(s, name);
    if (r) return r;
  }
  return null;
}

/** One module for a set of names that keep their spelling there: then only the string changes. */
function allSame(names: string[]): string | null {
  const rs = names.map(lookup);
  if (rs.some((r, i) => !r || r.orig !== names[i])) return null;
  const m = new Set(rs.map((r) => r!.module));
  return m.size === 1 ? rs[0]!.module : null;
}

interface Item { local: string; imported: string; typeOnly: boolean; isDefault: boolean }
type Located = Item & { orig: string };

function group(items: Item[]): Map<string, Located[]> | string {
  const out = new Map<string, Located[]>();
  for (const it of items) {
    const r = lookup(it.imported);
    if (!r) return `'${it.imported}' is not defined by anything the barrel re-exports`;
    if (!out.has(r.module)) out.set(r.module, []);
    out.get(r.module)!.push({ ...it, orig: r.orig });
  }
  return out;
}

const leftmost = (q: ts.EntityName): ts.Identifier => (ts.isIdentifier(q) ? q : leftmost(q.left));
const unwrap = (n: ts.Node): ts.Node => {
  while (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent) || ts.isAsExpression(n.parent)) {
    n = n.parent;
  }
  return n;
};

function emit(kw: 'import' | 'export', typeOnly: boolean, def: string | undefined, its: Located[], spec: string, st: Style): string {
  const pieces = its.map((i) => `${i.typeOnly ? 'type ' : ''}${i.orig === i.local ? i.orig : `${i.orig} as ${i.local}`}`);
  return emitStatement(kw, typeOnly, def, pieces, spec, st);
}

// ---- scan importers ----------------------------------------------------------------------------
const files = walkFiles(root).filter((f) => f !== barrel);
const edits = new Map<string, Edit[]>();
const log: string[] = [];
const refused: string[] = [];
const unresolved: string[] = [];
const refsOfBarrel = (f: string) => findRefs(parse(root, f).sf).filter((r) => resolveSpec(root, f, r.spec) === barrel);

for (const f of files) {
  const { text, sf } = parse(root, f);
  for (const ref of findRefs(sf)) {
    if (resolveSpec(root, f, ref.spec) !== barrel) continue;
    const here = `${f}:${ref.line}`;
    if (ref.kind === 'mock' && MOCK_REFUSE.has(ref.fn!)) {
      refused.push(`${here}: jest.${ref.fn}('${ref.spec}') names the barrel`);
      continue;
    }
    const fail = (why: string) => unresolved.push(`${here}: ${why}`);
    const addEdit = (e: Edit, shown: string) => {
      if (!edits.has(f)) edits.set(f, []);
      edits.get(f)!.push(e);
      log.push(`${here}: ${shown}`);
    };
    const spec = (module: string) => formatSpec(ref.spec, module, f);
    const swapSpec = (module: string) =>
      addEdit({ start: ref.start, end: ref.end, text: spec(module) }, `'${ref.spec}' -> '${spec(module)}'`);

    if (singleStar) { swapSpec(stars[0]); continue; }

    if (ref.kind === 'import' || ref.kind === 'export') {
      const decl = ref.node as ts.ImportDeclaration | ts.ExportDeclaration;
      const start = decl.getStart(sf);
      const st = styleOf(text, decl, ref);
      const replaceWith = (stmts: string[], what: string) =>
        addEdit({ start, end: decl.getEnd(), text: stmts.join(`\n${st.pad}`) }, what);

      let items: Item[];
      let typeOnly: boolean;
      if (ts.isImportDeclaration(decl)) {
        const clause = decl.importClause;
        if (!clause) { fail('side-effect import of the barrel'); continue; }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) { fail('namespace import of a multi-source barrel'); continue; }
        typeOnly = clause.isTypeOnly;
        items = [];
        if (clause.name) items.push({ local: clause.name.text, imported: 'default', typeOnly: false, isDefault: true });
        for (const el of clause.namedBindings?.elements ?? []) {
          items.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, typeOnly: el.isTypeOnly, isDefault: false });
        }
      } else {
        typeOnly = decl.isTypeOnly;
        if (!decl.exportClause) {
          const stmts = barrelDecls.map(({ decl: b, module }) => {
            const t = typeOnly || b.isTypeOnly ? 'type ' : '';
            const clause = b.exportClause ? `{ ${(b.exportClause as ts.NamedExports).elements.map((e) => e.getText()).join(', ')} }` : '*';
            return `export ${t}${clause} from ${st.q}${spec(module)}${st.q}${st.semi}`;
          });
          replaceWith(stmts, `export * expanded to ${stmts.length} statement(s)`);
          continue;
        }
        if (ts.isNamespaceExport(decl.exportClause)) { fail('export * as ns of a multi-source barrel'); continue; }
        items = decl.exportClause.elements.map((el) => ({
          local: el.name.text, imported: (el.propertyName ?? el.name).text, typeOnly: el.isTypeOnly, isDefault: false,
        }));
      }
      const only = allSame(items.map((i) => i.imported));
      if (only) { swapSpec(only); continue; }
      const groups = group(items);
      if (typeof groups === 'string') { fail(groups); continue; }
      const kw = ts.isImportDeclaration(decl) ? 'import' : 'export';
      const stmts = [...groups].map(([module, its]) => {
        const d = kw === 'import' ? its.find((i) => i.isDefault && i.orig === 'default') : undefined;
        return emit(kw, typeOnly, d?.local, its.filter((i) => i !== d), spec(module), st);
      });
      replaceWith(stmts, `split into ${stmts.length} ${kw}(s)`);
    } else if (ref.kind === 'typeimport') {
      const q = (ref.node as ts.ImportTypeNode).qualifier;
      const m = q ? allSame([leftmost(q).text]) : null;
      if (m) swapSpec(m);
      else fail(`typeof import('${ref.spec}') without a resolvable first member`);
    } else if (ref.kind === 'require' || ref.kind === 'dynamic') {
      const call = unwrap(ref.node);
      const parent = call.parent;
      let m: string | null = null;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === call) m = allSame([parent.name.text]);
      else if (ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isObjectBindingPattern(parent.name)) {
        const els = parent.name.elements;
        if (els.every((e) => !e.dotDotDotToken && ts.isIdentifier(e.name))) {
          m = allSame(els.map((e) => (e.propertyName ?? e.name).getText()));
        }
      }
      if (m) swapSpec(m);
      else fail(`${ref.kind}('${ref.spec}') of a multi-source barrel is used as a whole module`);
    } else {
      fail(`jest.${ref.fn}('${ref.spec}') cannot be rewritten by name`);
    }
  }
}

// ---- report, write, delete ---------------------------------------------------------------------
if (refused.length) die([`R10: ${refused.length} mock(s) name the barrel, nothing written:`, ...refused.map((r) => `  ${r}`)]);
if (unresolved.length) die([`${unresolved.length} importer(s) cannot be rewritten by name, nothing written:`, ...unresolved.map((r) => `  ${r}`)]);

console.log(log.join('\n'));
if (!check) {
  for (const [f, es] of edits) {
    const abs = path.join(root, f);
    fs.writeFileSync(abs, applyEdits(fs.readFileSync(abs, 'utf8'), es));
  }
}
const remaining = check ? 0 : files.reduce((n, f) => n + refsOfBarrel(f).length, 0);
let deleted = false;
if (del && remaining === 0) {
  if (!check) {
    try { git(root, ['rm', '-f', '--quiet', '--', barrel]); } catch { fs.rmSync(path.join(root, barrel)); }
  }
  deleted = true;
} else if (del) {
  console.error(`not deleting ${barrel}: ${remaining} importer(s) remain`);
}
console.log(
  `${check ? 'check: would rewrite' : 'rewrote'} ${log.length} importer statement(s) in ${edits.size} file(s)` +
    `${deleted ? `, ${check ? 'would delete' : 'deleted'} ${barrel}` : ''}`,
);
