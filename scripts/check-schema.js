#!/usr/bin/env node
/**
 * check:schema — validate every GraphQL document the app sends against
 * `schema.gql`.
 *
 * ## Why this exists
 *
 * `npm run codegen` reads `schema.gql` and emits TYPES only. It never looks at
 * a single query. Nothing else in the build does either, and the service tests
 * mock Apollo Client wholesale — so a query naming a field the server does not
 * have is invisible to `tsc`, to `jest`, and to CI. It surfaces at runtime, as
 * a GRAPHQL_VALIDATION_FAILED on a real user's device.
 *
 * That gap is not hypothetical. `articlesForCluster` sat in this repo as a
 * fully-wired service method whose query had no matching field in the schema.
 *
 * It also matters for anyone pointing the app at their own backend: `schema.gql`
 * doubles as the contract a self-hosted server must satisfy (see the README),
 * and this is how you check your server actually satisfies it. Export your
 * server's SDL over `schema.gql`, run this, and every incompatibility is listed
 * before you build.
 *
 * ## What it checks
 *
 * Every `gql` -tagged document under SCAN_DIRS is parsed and run through
 * `graphql.validate()` against `schema.gql`. Unknown fields, unknown arguments,
 * wrong variable types, and malformed documents all fail the run.
 *
 * A document may interpolate one `${IDENTIFIER}` — a shared field-list constant
 * such as `FACT_CHECK_FIELDS` — spliced into the selection set at build time.
 * `resolveIdentifier` inlines it before parsing: it looks for a top-level
 * `const IDENTIFIER = \`...\`` (or quoted-string) declaration first in the same
 * file, then one import hop away via that file's own `import { IDENTIFIER }
 * from '...'`. This is deliberately shallow — one hop, plain string/template
 * constants only, no nested `${}` inside the resolved value — because the only
 * real user (`FACT_CHECK_FIELDS`) is a documented leaf module for exactly this
 * reason. An interpolation that resolution can't find is reported as its own
 * failure (`could not resolve `, naming the identifier) rather than a generic
 * parse error, so it is never silently skipped as unchecked.
 *
 * ## What it does NOT check
 *
 * - Test fixtures (`__tests__`, `__test-helpers__`). Those documents are never
 *   sent to a real server, and some are deliberately synthetic.
 * - `harness-local/adapters/graphql-news-api.ts`. It holds copies of two
 *   production documents as plain template strings rather than `gql` tags,
 *   precisely so the Node harness can run without Apollo. Untagged strings are
 *   indistinguishable from any other template literal, so they are out of
 *   scope; the originals in `lib/article-service.ts` are checked.
 * - Whether the server actually implements a field it declares. That is a
 *   server-side concern; the SDL is taken at its word here.
 * - An interpolated constant computed at runtime, built from more than one
 *   import hop, or holding its own nested `${}` — resolution gives up and the
 *   document fails loudly with "could not resolve" rather than guessing.
 *
 * Usage:
 *   npm run check:schema                  # validate against ./schema.gql
 *   npm run check:schema -- path/to.gql   # validate against another SDL
 */

const fs = require('fs');
const path = require('path');
const { buildSchema, parse, validate } = require('graphql');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'app', 'components'];
const SKIP_DIR_NAMES = new Set(['node_modules', '__tests__', '__test-helpers__']);
const SOURCE_EXT = new Set(['.ts', '.tsx']);

/**
 * A GraphQL document must open with an operation or fragment keyword. Requiring
 * one is what keeps the word "gql`" inside a prose comment from being picked up
 * as a document — which is otherwise indistinguishable to a regex.
 */
const DOC_START = /^(query|mutation|subscription|fragment)\b/;

function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry.name)) sourceFiles(full, acc);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/** Every `gql`…`` body in `source`, in source order. No escaped backticks in
 * practice, so the next backtick always closes the document even though the
 * body may still carry an unresolved `${IDENTIFIER}`. */
function extractDocuments(source) {
  const docs = [];
  const opener = /\bgql`/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    const start = opener.lastIndex;
    const end = source.indexOf('`', start);
    if (end === -1) break;
    const body = source.slice(start, end).trim();
    opener.lastIndex = end + 1;
    if (DOC_START.test(body)) docs.push(body);
  }
  return docs;
}

function operationNameOf(doc) {
  const m = /\b(query|mutation|subscription|fragment)\s+(\w+)/.exec(doc);
  return m ? m[2] : '(anonymous)';
}

/** A top-level `const NAME = \`...\`` or `const NAME = '...'/"..."` in `source`, or null. */
function findConstValue(source, name) {
  const template = new RegExp(`const\\s+${name}\\s*=\\s*\`([\\s\\S]*?)\``, 'm').exec(source);
  if (template) return template[1];
  const quoted = new RegExp(`const\\s+${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'm').exec(source);
  return quoted ? quoted[2] : null;
}

/** Resolve a relative import specifier from `fromFile` to an actual source file, or null. */
function resolveModuleFile(fromFile, importPath) {
  if (!importPath.startsWith('.')) return null; // only local modules carry a shared gql constant
  const base = path.resolve(path.dirname(fromFile), importPath);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/**
 * Resolve `name` to a string: a same-file const first, else one import hop.
 * See the file header for why this stays this shallow.
 */
function resolveIdentifier(name, filePath, source) {
  const local = findConstValue(source, name);
  if (local !== null) return local;

  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    const imported = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (!imported.includes(name)) continue;
    const modFile = resolveModuleFile(filePath, m[2]);
    if (!modFile) continue;
    const val = findConstValue(fs.readFileSync(modFile, 'utf8'), name);
    if (val !== null) return val;
  }
  return null;
}

/**
 * Inline every `${IDENTIFIER}` in `body` using `resolveIdentifier`. Returns
 * the resolved body plus any identifiers that could not be resolved — the
 * caller fails the document explicitly on those rather than handing an
 * unresolved `${...}` to the parser, which fails with an opaque syntax error.
 */
function resolveInterpolations(body, filePath, source) {
  const unresolved = [];
  const resolved = body.replace(/\$\{\s*(\w+)\s*\}/g, (full, name) => {
    const value = resolveIdentifier(name, filePath, source);
    if (value === null) {
      unresolved.push(name);
      return full;
    }
    return value;
  });
  return { resolved, unresolved };
}

function main() {
  const schemaPath = path.resolve(ROOT, process.argv[2] || 'schema.gql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`check:schema — schema not found: ${schemaPath}`);
    process.exit(2);
  }

  let schema;
  try {
    schema = buildSchema(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    console.error(`check:schema — could not build ${path.relative(ROOT, schemaPath)}:`);
    console.error(`  ${err.message}`);
    process.exit(2);
  }

  const failures = [];
  let documentCount = 0;
  let fileCount = 0;

  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const source = fs.readFileSync(file, 'utf8');
      const docs = extractDocuments(source);
      if (docs.length === 0) continue;
      fileCount += 1;
      const rel = path.relative(ROOT, file);

      for (const rawDoc of docs) {
        documentCount += 1;
        const name = operationNameOf(rawDoc);
        const { resolved: doc, unresolved } = resolveInterpolations(rawDoc, file, source);
        if (unresolved.length > 0) {
          failures.push({
            rel,
            name,
            messages: unresolved.map(
              (id) => `could not resolve \${${id}} — extend check-schema.js's resolver for this identifier`,
            ),
          });
          continue;
        }
        let ast;
        try {
          ast = parse(doc);
        } catch (err) {
          failures.push({ rel, name, messages: [`could not be parsed: ${err.message}`] });
          continue;
        }
        const errors = validate(schema, ast);
        if (errors.length > 0) {
          failures.push({ rel, name, messages: errors.map((e) => e.message) });
        }
      }
    }
  }

  const against = path.relative(ROOT, schemaPath) || schemaPath;

  if (failures.length > 0) {
    console.error(
      `\ncheck:schema — ${failures.length} of ${documentCount} documents do not match ${against}:\n`,
    );
    for (const f of failures) {
      console.error(`  ${f.rel} :: ${f.name}`);
      for (const m of f.messages) console.error(`      ${m}`);
      console.error('');
    }
    console.error(
      'A document naming a field the schema does not have fails at RUNTIME, on a\n' +
        'user device, with GRAPHQL_VALIDATION_FAILED. Fix the query, or update\n' +
        'schema.gql from your server and re-run `npm run codegen`.\n',
    );
    process.exit(1);
  }

  console.log(
    `check:schema — ${documentCount} documents across ${fileCount} files validate against ${against}.`,
  );
}

main();
