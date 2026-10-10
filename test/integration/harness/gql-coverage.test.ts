// Contract: the mock backend answers every GraphQL operation the app sends, and
// answers it with every field the app's own document selects. Documents are read as
// text from lib/, app/ and components/ with the same rules as scripts/check-schema.js.
import fs from 'node:fs';
import path from 'node:path';
import { parse, type FieldNode, type SelectionSetNode } from 'graphql';
import { GQL_OPERATIONS } from '@/test/mock-backend/graphql';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';

const ROOT = path.resolve(__dirname, '../../..');
const SCAN_DIRS = ['lib', 'app', 'components'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__test-helpers__']);
const DOC_START = /^(query|mutation|subscription|fragment)\b/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function findConst(source: string, name: string): string | null {
  const template = new RegExp(`const\\s+${name}\\s*=\\s*\`([\\s\\S]*?)\``, 'm').exec(source);
  if (template) return template[1];
  const quoted = new RegExp(`const\\s+${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'm').exec(source);
  return quoted ? quoted[2] : null;
}

// A ${NAME} splice is a const in the same file or one relative import away.
function resolveSplice(name: string, file: string, source: string): string {
  const local = findConst(source, name);
  if (local !== null) return local;
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source)) !== null) {
    if (!m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).includes(name)) continue;
    const base = path.resolve(path.dirname(file), m[2]);
    const target = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((f) => fs.existsSync(f));
    const value = target && findConst(fs.readFileSync(target, 'utf8'), name);
    if (value) return value;
  }
  throw new Error(`cannot resolve \${${name}} in ${file}`);
}

interface AppDocument {
  name: string;
  kind: string;
  file: string;
  text: string;
}

/** Every gql document the app sends, splices resolved. Fragments are not operations. */
export function collectDocuments(): AppDocument[] {
  const docs: AppDocument[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const source = fs.readFileSync(file, 'utf8');
      const opener = /\bgql`/g;
      while (opener.exec(source) !== null) {
        const end = source.indexOf('`', opener.lastIndex);
        const body = source.slice(opener.lastIndex, end).trim();
        opener.lastIndex = end + 1;
        if (!DOC_START.test(body)) continue;
        const head = /^(query|mutation|subscription|fragment)\s+(\w+)/.exec(body);
        if (!head || head[1] === 'fragment') continue;
        docs.push({
          name: head[2],
          kind: head[1],
          file: path.relative(ROOT, file),
          text: body.replace(/\$\{\s*(\w+)\s*\}/g, (_, id) => resolveSplice(id, file, source)),
        });
      }
    }
  }
  return docs;
}

const documents = collectDocuments();
const appOperations = [...new Set(documents.map((d) => d.name))].sort();

describe('GraphQL handler coverage', () => {
  it('collects the app operations (positive control)', () => {
    expect(appOperations).toContain('GetArticleIdsForPersona');
    expect(appOperations).toContain('AdvanceOnboardingStage');
    expect(appOperations.length).toBeGreaterThan(40);
  });

  it('has a default handler for every operation the app sends', () => {
    expect(appOperations.filter((n) => !GQL_OPERATIONS.includes(n))).toEqual([]);
  });

  it('has no handler for an operation the app no longer sends', () => {
    expect(GQL_OPERATIONS.filter((n) => !appOperations.includes(n))).toEqual([]);
  });

  it('lists each operation once', () => {
    expect(new Set(GQL_OPERATIONS).size).toBe(GQL_OPERATIONS.length);
  });
});

// A handler that omits a selected field makes Apollo warn and hand the caller partial
// data, which no test would notice. Send each document with plausible variables and
// check the response carries every field it selects.
const PERSONA_QUERY = {
  topics: [{ text: 'bridges' }, { text: 'trams' }],
  topHeadlines: { scopes: [{ scope: 'COUNTRY', countryCode: 'NLD' }, { scope: 'GLOBAL' }] },
};
const USER = '66e2e0000000000000000001';
const VARIABLES: Record<string, Record<string, unknown>> = {
  GetArticleById: { id: ARTICLE_IDS[0] },
  GetArticleIdsForPersona: { query: PERSONA_QUERY },
  GetArticleIdsForTopics: { topics: [{ topicText: 'bridges' }] },
  GetArticlesForTopicsByIds: { articleIds: [...ARTICLE_IDS] },
  GetArticlesForStories: { articleIds: [...ARTICLE_IDS] },
  GetNewsClusterForArticle: { articleId: ARTICLE_IDS[0] },
  GetArticlesForPublisher: { newsPublisherId: 'd00000000000000000000001' },
  GetArticlesForPublisherNoOrder: { newsPublisherId: 'd00000000000000000000001' },
  PublicationSourcesForNewsPublisher: { publisherId: 'd00000000000000000000001' },
  PublicationDisplayNames: { language: 'en', names: ['Harbour Daily'] },
  SearchPublishers: { query: 'a' },
  GetRelatedArticlesPage: { articleId: ARTICLE_IDS[0] },
  GetRelatedArticlesPageFiltered: { articleId: ARTICLE_IDS[0] },
  UpdateNotificationWindow: { input: { userId: USER, preferredNotificationWindow: [8, 20] } },
  UpdateExpoPushToken: { input: { userId: USER, expoPushToken: 'ExponentPushToken[fixture]' } },
  AdvanceOnboardingStage: { userId: USER, stage: 'FINISHED' },
  UpdateNotificationsEnabled: { input: { userId: USER, enabled: true } },
  UpdateProcessingMode: { input: { userId: USER, mode: 'CLOUD' } },
  UpdateUserConfig: { input: { userId: USER, language_codes: ['en'] } },
  RequestUnblock: { input: { userId: USER, feedback: 'please', chatHistory: [] } },
};

function missingFields(sel: SelectionSetNode, data: unknown, trail: string): string[] {
  if (Array.isArray(data)) return data.flatMap((d, i) => missingFields(sel, d, `${trail}[${i}]`));
  if (data === null) return [];
  if (typeof data !== 'object') return [`${trail} is not an object`];
  const row = data as Record<string, unknown>;
  return sel.selections.flatMap((s) => {
    const f = s as FieldNode;
    const key = f.alias?.value ?? f.name.value;
    if (!(key in row)) return [`${trail}.${key}`];
    return f.selectionSet ? missingFields(f.selectionSet, row[key], `${trail}.${key}`) : [];
  });
}

describe('GraphQL handler responses', () => {
  it.each(documents.map((d) => [d.name, d] as const))('%s answers every selected field', async (_name, doc) => {
    const res = await fetch('http://127.0.0.1:8790/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: doc.name, query: doc.text, variables: VARIABLES[doc.name] ?? {} }),
    });
    const body = (await res.json()) as { data: Record<string, unknown>; errors?: unknown };
    expect(body.errors).toBeUndefined();
    const op = parse(doc.text).definitions[0] as { selectionSet: SelectionSetNode };
    expect(missingFields(op.selectionSet, body.data, doc.name)).toEqual([]);
  });
});
