// Shared helpers for the P4 codemods (move-module.ts, rewrite-barrel.ts).
// Parses with the TypeScript compiler API; never edits text outside a specifier or an import/export
// statement. All paths are POSIX, relative to the root (the app dir by default).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const WALK_DIRS = ['app', 'components', 'lib', 'modules', 'test', 'harness-local', 'eval'];
const WALK_FILES = ['index.js'];
const SKIP = new Set(['node_modules', '.stryker-tmp', 'e2e-output', 'android', 'ios', 'coverage', 'dist']);
const SKIP_PATHS = new Set(['lib/generated']);
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/;
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx'];
// jest.* calls whose first argument is a module specifier.
export const JEST_FNS = new Set(['mock', 'doMock', 'requireActual', 'requireMock', 'unmock']);
// R10: naming a module in these means the module cannot move or be split safely.
export const MOCK_REFUSE = new Set(['mock', 'doMock', 'requireActual']);

export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    if (SKIP_PATHS.has(rel)) return;
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) visit(r);
      else if (e.isFile() && CODE_EXT.test(e.name)) out.push(r);
    }
  };
  for (const d of WALK_DIRS) if (fs.existsSync(path.join(root, d))) visit(d);
  for (const f of WALK_FILES) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.sort();
}

export function parse(root: string, rel: string): { text: string; sf: ts.SourceFile } {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const kind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.ts$/.test(rel)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  return { text, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind) };
}

export type RefKind = 'import' | 'export' | 'require' | 'dynamic' | 'mock' | 'typeimport';
export interface SpecRef {
  kind: RefKind;
  spec: string;
  /** Range of the specifier text between the quotes. */
  start: number;
  end: number;
  line: number;
  /** jest function name for kind 'mock'. */
  fn?: string;
  /** import/export declaration, call expression, import-equals or ImportTypeNode. */
  node: ts.Node;
}

const isLit = (n: ts.Node | undefined): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));

/** Every module specifier string in a file: static, require, jest.*, import(), typeof import(). */
export function findRefs(sf: ts.SourceFile): SpecRef[] {
  const refs: SpecRef[] = [];
  const add = (kind: RefKind, lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral, node: ts.Node, fn?: string) => {
    const start = lit.getStart(sf) + 1;
    refs.push({
      kind, spec: lit.text, start, end: lit.getEnd() - 1, node, fn,
      line: sf.getLineAndCharacterOfPosition(start).line + 1,
    });
  };
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && isLit(n.moduleSpecifier)) {
      add(ts.isImportDeclaration(n) ? 'import' : 'export', n.moduleSpecifier, n);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      if (isLit(n.moduleReference.expression)) add('require', n.moduleReference.expression, n);
    } else if (ts.isCallExpression(n) && isLit(n.arguments[0])) {
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === 'require') add('require', n.arguments[0], n);
      else if (e.kind === ts.SyntaxKind.ImportKeyword) add('dynamic', n.arguments[0], n);
      else if (
        ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) &&
        e.expression.text === 'jest' && JEST_FNS.has(e.name.text)
      ) add('mock', n.arguments[0], n, e.name.text);
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && isLit(n.argument.literal)) {
      add('typeimport', n.argument.literal, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return refs;
}

const isFile = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile();

/** Resolve an `@/` or relative specifier to a root-relative file, or null (package, missing). */
export function resolveSpec(root: string, importerRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (/^\.\.?(\/|$)/.test(spec)) base = path.posix.join(path.posix.dirname(importerRel), spec);
  else return null;
  base = base.replace(/\/$/, '');
  const candidates = [
    base,
    ...RESOLVE_EXT.map((e) => base + e),
    ...RESOLVE_EXT.map((e) => `${base}/index${e}`),
  ];
  return candidates.find((c) => isFile(path.join(root, c))) ?? null;
}

/**
 * Print `targetRel` as a specifier from `importerRel`, in the style of `origSpec`:
 * `@/` stays `@/`, relative stays relative, an explicit extension or `/index` is kept.
 */
export function formatSpec(origSpec: string, targetRel: string, importerRel: string): string {
  let t = targetRel;
  if (!/\.(tsx?|jsx?|json)$/.test(origSpec)) t = t.replace(/\.(tsx?|jsx?)$/, '');
  if (!/(^|\/)index(\.\w+)?$/.test(origSpec)) t = t.replace(/(^|\/)index$/, '');
  if (origSpec.startsWith('@/')) return `@/${t}`;
  let r = path.posix.relative(path.posix.dirname(importerRel), t) || '.';
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Throws when two edits to one file overlap: applying both would corrupt the file silently. */
export function assertNoOverlap(file: string, edits: Edit[]): void {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(`overlapping edits in ${file} at offsets ${sorted[i - 1].start}-${sorted[i - 1].end} and ${sorted[i].start}-${sorted[i].end}`);
    }
  }
}

export function applyEdits(text: string, edits: Edit[]): string {
  assertNoOverlap('(file)', edits);
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

export function parseArgs(argv: string[], valued: string[]): { flags: Set<string>; vals: Record<string, string> } {
  const flags = new Set<string>();
  const vals: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) vals[a] = argv[++i] ?? '';
    else flags.add(a);
  }
  return { flags, vals };
}

export function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

export interface Style { q: string; semi: string; pad: string }

/** Quote, semicolon and indentation of an import/export statement, to print new ones alike. */
export function styleOf(text: string, decl: ts.Node, ref: SpecRef): Style {
  const start = decl.getStart();
  return {
    q: text[ref.start - 1],
    semi: text[decl.getEnd() - 1] === ';' ? ';' : '',
    pad: /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', start - 1) + 1))![0],
  };
}

/** Print `import|export [type] [def, ] { pieces } from 'spec'`, wrapped like prettier past 100 columns. */
export function emitStatement(
  kw: 'import' | 'export', typeOnly: boolean, def: string | undefined, pieces: string[], spec: string, st: Style,
): string {
  const head = `${kw} ${typeOnly ? 'type ' : ''}${def ? `${def}${pieces.length ? ', ' : ''}` : ''}`;
  const tail = ` from ${st.q}${spec}${st.q}${st.semi}`;
  if (!pieces.length) return `${head.trimEnd()}${tail}`;
  const one = `${head}{ ${pieces.join(', ')} }${tail}`;
  if (st.pad.length + one.length <= 100) return one;
  return `${head}{\n${pieces.map((p) => `${st.pad}  ${p},`).join('\n')}\n${st.pad}}${tail}`;
}
