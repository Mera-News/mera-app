// A fact check is visible only if THIS DEVICE asked for it (owner decision,
// navx). Source sweep, so a new caller fails here before it ships:
//   • the billed ask (`requestFactCheck`, the `factCheck` query) is reached only
//     from the user's own tap (the tick, the chat pill) and the asked-only
//     panel poll;
//   • the read-only `cachedFactCheck` query lives only in the client, where
//     its one caller re-reads the asked list;
//   • nothing lands or sweeps a check another reader asked for.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const DIRS = ['app', 'components', 'lib'];
const SKIP = /(__tests__|__mocks__|node_modules|\/generated\/|\/locales\/)/;

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT, full);
      if (SKIP.test(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push({ rel, text: fs.readFileSync(full, 'utf8') });
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));
  return out;
}

const ALL = sources();
const filesMatching = (re: RegExp) =>
  ALL.filter((f) => re.test(f.text))
    .map((f) => f.rel)
    .sort();

const CLIENT = 'lib/fact-check/fact-check-graphql-client.ts';

it('the sweep sees the client (negative control)', () => {
  expect(ALL.map((f) => f.rel)).toContain(CLIENT);
});

it('only the tap paths and the asked-only poll call requestFactCheck', () => {
  expect(filesMatching(/\brequestFactCheck\(/).filter((f) => f !== CLIENT)).toEqual([
    'lib/chat-tools/quick-fact-check-handler.ts',
    'lib/fact-check/request-article-fact-check.ts',
    'lib/fact-check/use-fact-check.ts',
  ]);
});

it('the tap paths ask explicitly; the poll does not', () => {
  const text = (rel: string) => ALL.find((f) => f.rel === rel)!.text;
  expect(text('lib/fact-check/request-article-fact-check.ts')).toMatch(
    /requestFactCheck\([^)]*,\s*true\)/,
  );
  expect(text('lib/chat-tools/quick-fact-check-handler.ts')).toMatch(
    /requestFactCheck\([\s\S]*?\btrue\b[^)]*\)/,
  );
  expect(text('lib/fact-check/use-fact-check.ts')).toMatch(/requestFactCheck\(articleId\)/);
});

it('the billed and read-only fact-check queries live only in the client', () => {
  expect(filesMatching(/\bfactCheck\(articleId:/)).toEqual([CLIENT]);
  expect(filesMatching(/\bcachedFactCheck\(articleId:/)).toEqual([CLIENT]);
});

it('no code lands or sweeps a check this device did not ask for', () => {
  expect(
    filesMatching(/\b(mirrorArticleFactCheck|fetchCachedFactCheck|reconcileStoredFactChecks)\b/),
  ).toEqual([]);
  expect(filesMatching(/factCheck\s*@include/)).toEqual([]);
});
