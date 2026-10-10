// lib/algorithms stays pure: every module in it loads in plain Node with nothing mocked.
//
// The authority for that rule (the ESLint override in eslint.config.js is the fast editor signal).
// Every non-test file under lib/algorithms is parsed with the TypeScript compiler and each VALUE
// import is checked: static imports, re-exports, side-effect imports, require() and import().
// Type-only imports are skipped (they vanish at compile time). A value import may name another
// file inside lib/algorithms, or a package that is not on the forbidden list; nothing else.
//
// NEGATIVE CONTROLS INCLUDED. A check that has never been seen to fail proves nothing, so the same
// checker runs against lib/logger.ts (imports @sentry) and against a planted fixture with one
// forbidden package and one relative import that leaves lib/algorithms; both must be flagged.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..', '..', '..');
const ALGORITHMS = join(ROOT, 'lib', 'algorithms');

/** Packages no algorithm may load at runtime. Mirrors the ESLint override. */
const FORBIDDEN: RegExp[] = [
  /^react($|-|\/)/,
  /^react-native($|-|\/)/,
  /^expo($|-|\/)/,
  /^@expo\//,
  /^@sentry\//,
  /^(@better-auth\/|better-auth($|\/))/,
  /^@nozbe\//,
  /^zustand($|\/)/,
  /^@apollo\//,
  /^(react-)?i18next$/,
];

/** The value-import specifiers of one file. */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : null;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && named !== null && named.length > 0 && named.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The file a local specifier names, or null for a package. */
function localTarget(from: string, spec: string): string | null {
  if (spec.startsWith('@/')) return join(ROOT, spec.slice(2));
  if (spec.startsWith('.')) return resolve(dirname(from), spec);
  return null;
}

/** Why `file` is not pure: one entry per offending import. */
function violationsOf(file: string): string[] {
  const out: string[] = [];
  for (const spec of valueImports(file)) {
    const target = localTarget(file, spec);
    if (target === null) {
      if (FORBIDDEN.some((re) => re.test(spec))) out.push(`${spec} (forbidden package)`);
    } else if (!(target + sep).startsWith(ALGORITHMS + sep) || target.startsWith(join(ALGORITHMS, '__tests__'))) {
      out.push(`${spec} (outside lib/algorithms)`);
    }
  }
  return out;
}

/** Every non-test source file under lib/algorithms. */
function algorithmFiles(dir = ALGORITHMS): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : algorithmFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('lib/algorithms purity', () => {
  it('has modules to check', () => {
    expect(algorithmFiles().length).toBeGreaterThan(0);
  });

  it('every module loads nothing impure', () => {
    const report = algorithmFiles()
      .map((f) => [relative(ROOT, f), violationsOf(f)] as const)
      .filter(([, v]) => v.length > 0);
    expect(report).toEqual([]);
  });
});

describe('the checker can fail (negative controls)', () => {
  it('flags lib/logger.ts, which loads Sentry', () => {
    expect(violationsOf(join(ROOT, 'lib', 'logger.ts'))).toEqual(
      expect.arrayContaining([expect.stringContaining('@sentry/react-native')]),
    );
  });

  it('flags a forbidden package and a relative import that leaves lib/algorithms', () => {
    const found = violationsOf(join(__dirname, 'fixtures', 'impure.ts'));
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringContaining('react-native (forbidden package)'),
        expect.stringContaining('(outside lib/algorithms)'),
      ]),
    );
  });

  it('skips type-only imports', () => {
    expect(violationsOf(join(__dirname, 'fixtures', 'type-only.ts'))).toEqual([]);
  });
});
