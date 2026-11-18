// Every GraphQL document the app and the client send goes either to the person's news server or to Mera.
import fs from 'fs';
import path from 'path';
import { ACCOUNT_OPERATIONS, FEATURE_OF, MERA_ONLY_OPERATIONS, NEWS_OPERATIONS } from '@/lib/own-services/news-operations';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLIENT_ROOT } = require('../../../../client-resolution') as { CLIENT_ROOT: string };
const ROOT = path.resolve(__dirname, '../../../..');
const SCAN_DIRS = ['lib', 'app', 'components'].map((d) => path.join(ROOT, d)).concat(path.join(CLIENT_ROOT, 'lib'));
const SKIP = new Set(['node_modules', '__tests__', '__test-helpers__']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP.has(e.name)) sourceFiles(full, acc);
        } else if (/\.tsx?$/.test(e.name)) acc.push(full);
    }
    return acc;
}

// The same scan as scripts/check-schema.js: a gql tag whose body opens with an operation keyword.
function operationNames(): Set<string> {
    const names = new Set<string>();
    for (const dir of SCAN_DIRS) {
        for (const file of sourceFiles(dir)) {
            const source = fs.readFileSync(file, 'utf8');
            const opener = /\bgql`/g;
            while (opener.exec(source) !== null) {
                const end = source.indexOf('`', opener.lastIndex);
                if (end === -1) break;
                const body = source.slice(opener.lastIndex, end).trim();
                opener.lastIndex = end + 1;
                const op = /^(query|mutation|subscription)\s+(\w+)/.exec(body);
                if (op) names.add(op[2]);
                else if (/^(query|mutation|subscription)\b/.test(body)) names.add(`(anonymous in ${path.relative(ROOT, file)})`);
            }
        }
    }
    return names;
}

describe('GraphQL document classification', () => {
    const found = operationNames();

    it('finds the documents at all', () => {
        expect(found.size).toBeGreaterThan(40);
    });

    it('puts every document in exactly one of news, account or Mera only', () => {
        const sets = [NEWS_OPERATIONS, ACCOUNT_OPERATIONS, MERA_ONLY_OPERATIONS];
        const wrongCount = [...found].filter((n) => sets.filter((set) => set.has(n)).length !== 1);
        expect(wrongCount).toEqual([]);
    });

    it('names no document that does not exist', () => {
        const stale = [...NEWS_OPERATIONS, ...ACCOUNT_OPERATIONS, ...MERA_ONLY_OPERATIONS].filter((n) => !found.has(n));
        expect(stale).toEqual([]);
    });

    it('maps features only for operations that go to a news server', () => {
        expect(Object.keys(FEATURE_OF).filter((n) => !NEWS_OPERATIONS.has(n) && !MERA_ONLY_OPERATIONS.has(n))).toEqual([]);
    });
});
