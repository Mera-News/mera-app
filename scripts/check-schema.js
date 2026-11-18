#!/usr/bin/env node
/**
 * check:schema — validate every GraphQL document the app sends against
 * `schema.gql` from the installed mera-news-client.
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
 * It also matters for anyone pointing the app at their own backend: the client's
 * `schema.gql` doubles as the contract a self-hosted server must satisfy (see the
 * README), and this is how you check your server actually satisfies it. Pass your
 * server's SDL as an argument and every incompatibility is listed before you build.
 *
 * ## What it checks
 *
 * Every `gql` -tagged document under SCAN_DIRS, and under the client's `lib`, is parsed and run through
 * `graphql.validate()`. News operations the public news server answers go against the client's
 * `news-schema.gql`; account, Mera service and the held-back news operations go against `schema.gql`.
 * The lists come from the client's `lib/graphql/news-operations.ts`. A document whose name is in no
 * list fails, and so does a held-back news operation that has started to validate publicly. Unknown
 * fields, unknown arguments, wrong variable types, and malformed documents all fail the run.
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
 *   scope; the originals in the client's `lib/article-service.ts` are checked.
 * - Whether the server actually implements a field it declares. That is a
 *   server-side concern; the SDL is taken at its word here.
 * - An interpolated constant computed at runtime, built from more than one
 *   import hop, or holding its own nested `${}` — resolution gives up and the
 *   document fails loudly with "could not resolve" rather than guessing.
 *
 * Usage:
 *   npm run check:schema                  # news against news-schema.gql, the rest against schema.gql
 *   npm run check:schema -- path/to.gql   # validate everything against another SDL
 */

const fs = require('fs');
const path = require('path');
const { buildSchema, parse, validate } = require('graphql');

const { CLIENT_ROOT } = require('../client-resolution');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'app', 'components'].map((d) => path.join(ROOT, d)).concat(path.join(CLIENT_ROOT, 'lib'));
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
  while (opener.exec(source) !== null) {
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

/** The operation lists, parsed from the client's source so they are never copied here. */
function loadClientLists() {
  const source = fs.readFileSync(path.join(CLIENT_ROOT, 'lib/graphql/news-operations.ts'), 'utf8');
  const block = (name, text = source) => {
    const m = new RegExp(`const ${name}\\b[^=]*=\\s*[\\[{]([\\s\\S]*?)[\\]}];`).exec(text);
    if (!m) throw new Error(`check:schema: ${name} not found`);
    return m[1];
  };
  const names = (name, text) => new Set([...block(name, text).matchAll(/'(\w+)'/g)].map((m) => m[1]));
  // The account documents that live in the app are named in the app's own list.
  const appSource = fs.readFileSync(path.join(ROOT, 'lib/own-services/news-operations.ts'), 'utf8');
  return {
    appAccount: names('APP_ACCOUNT_OPERATION_NAMES', appSource),
    news: names('NEWS_OPERATION_NAMES'),
    hostNews: names('HOST_NEWS_OPERATION_NAMES'),
    account: names('ACCOUNT_OPERATION_NAMES'),
    service: names('MERA_SERVICE_OPERATION_NAMES'),
    notPublic: new Set([...block('NEWS_OPERATIONS_NOT_PUBLIC').matchAll(/^\s*(\w+):/gm)].map((m) => m[1])),
  };
}

function loadSchemas() {
  const build = (file) => {
    try {
      return buildSchema(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`check:schema — could not build ${path.relative(ROOT, file)}:\n  ${err.message}`);
      process.exit(2);
    }
  };
  return {
    private: { schema: build(path.join(CLIENT_ROOT, 'schema.gql')), label: 'schema.gql (private app schema)' },
    public: { schema: build(path.join(CLIENT_ROOT, 'news-schema.gql')), label: 'news-schema.gql (public news schema)' },
  };
}

/** Every tagged document under SCAN_DIRS, interpolations inlined; a document that cannot be resolved carries `problems`. */
function collectDocuments() {
  const documents = [];
  let fileCount = 0;
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = fs.readFileSync(file, 'utf8');
      const docs = extractDocuments(source);
      if (docs.length === 0) continue;
      fileCount += 1;
      const rel = path.relative(ROOT, file);
      for (const rawDoc of docs) {
        const { resolved, unresolved } = resolveInterpolations(rawDoc, file, source);
        const problems = unresolved.map(
          (id) => `could not resolve \${${id}} — extend check-schema.js's resolver for this identifier`,
        );
        documents.push({ rel, name: operationNameOf(rawDoc), doc: resolved, problems });
      }
    }
  }
  return { documents, fileCount };
}

/** Which schema an operation is checked against: the public news schema only for news the public server answers. */
function schemaKeyFor(name, lists) {
  const isNews = lists.news.has(name) || lists.hostNews.has(name);
  if (!isNews && !lists.account.has(name) && !lists.appAccount.has(name) && !lists.service.has(name)) return null;
  return isNews && !lists.notPublic.has(name) ? 'public' : 'private';
}

function checkDocuments(documents, schemas, lists = loadClientLists()) {
  const failures = [];
  const counts = { public: 0, private: 0 };
  for (const { rel, name, doc, problems = [] } of documents) {
    const fail = (against, messages) => failures.push({ rel, name, against, messages });
    const key = schemaKeyFor(name, lists);
    if (key === null) {
      fail('no schema', [`operation ${name} is not classified: add it to the client's news-operations lists`]);
      continue;
    }
    const { schema, label } = schemas[key];
    counts[key] += 1;
    if (problems.length > 0) {
      fail(label, problems);
      continue;
    }
    let ast;
    try {
      ast = parse(doc);
    } catch (err) {
      fail(label, [`could not be parsed: ${err.message}`]);
      continue;
    }
    // graphql.validate does not report an operation whose root type the schema lacks.
    const rootless = ast.definitions.find(
      (d) => d.kind === 'OperationDefinition' && !schema.getRootType(d.operation),
    );
    if (rootless) {
      fail(label, [`the schema has no ${rootless.operation} root`]);
      continue;
    }
    const errors = validate(schema, ast).map((e) => e.message);
    if (errors.length > 0) {
      fail(label, errors);
      continue;
    }
    if (lists.notPublic.has(name) && validate(schemas.public.schema, ast).length === 0) {
      fail(label, [`${name} validates against the public schema: remove it from NEWS_OPERATIONS_NOT_PUBLIC`]);
    }
  }
  return { failures, counts };
}

function main() {
  const lists = loadClientLists();
  let schemas;
  if (process.argv[2]) {
    // One SDL for everything: a self-hoster checks a single server.
    const file = path.resolve(ROOT, process.argv[2]);
    if (!fs.existsSync(file)) {
      console.error(`check:schema — schema not found: ${file}`);
      process.exit(2);
    }
    let schema;
    try {
      schema = buildSchema(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`check:schema — could not build ${path.relative(ROOT, file)}:\n  ${err.message}`);
      process.exit(2);
    }
    const one = { schema, label: path.relative(ROOT, file) || file };
    schemas = { private: one, public: one };
    lists.notPublic = new Set();
  } else {
    schemas = loadSchemas();
  }

  const { documents, fileCount } = collectDocuments();
  const { failures, counts } = checkDocuments(documents, schemas, lists);

  if (failures.length > 0) {
    console.error(`\ncheck:schema — ${failures.length} of ${documents.length} documents do not match their schema:\n`);
    for (const f of failures) {
      console.error(`  ${f.rel} :: ${f.name}  (checked against ${f.against})`);
      for (const m of f.messages) console.error(`      ${m}`);
      console.error('');
    }
    console.error(
      'A document naming a field the schema does not have fails at RUNTIME, on a\n' +
        'user device, with GRAPHQL_VALIDATION_FAILED. Fix the query, or update\n' +
        'the schema file from your server and re-run `npm run codegen`.\n',
    );
    process.exit(1);
  }

  console.log(
    `check:schema — ${documents.length} documents across ${fileCount} files validate: ` +
      `${counts.public} against ${schemas.public.label}, ${counts.private} against ${schemas.private.label}.`,
  );
}

if (require.main === module) main();

module.exports = { loadSchemas, loadClientLists, collectDocuments, checkDocuments };
