// The app shows publications and news, never the RSS FEEDS behind them. This
// guard reads the SOURCE of every screen and component (comments stripped) and
// refuses feed-list UI: rendering a publisher's feeds, rendering search
// `matchingSources`, asking for one feed's articles, a feed URL, or navigating
// to the two deleted feed-era routes. It is deliberately narrow: a
// `publicationSourceId` or a feed's `publication_name` used as DATA (keying a
// preference, reading a source name) is allowed, because that is not a feed on
// screen.
//
// Proved able to fail below: each pattern is injected into a real file's
// source in memory and must be caught.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const SCAN_DIRS = ['components', 'app'];

/**
 * A publisher's feeds mapped to JSX rows (the old Sources accordion). Every
 * `.map(` whose receiver names `publicationSources` has its callback read to
 * the matching parenthesis; JSX anywhere inside it is a feed row, whether the
 * callback is `=> (<Row/>)` or a block ending in `return (<Row/>)`. A map to
 * plain data (the source names that key a preference) passes.
 */
function rendersPublicationSources(code: string): boolean {
    const receiver = /publicationSources[^;\n]{0,40}?\.map\(/g;
    let m: RegExpExecArray | null;
    while ((m = receiver.exec(code))) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < code.length && depth > 0) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')') depth--;
            i++;
        }
        if (/<[A-Za-z]/.test(code.slice(start, i))) return true;
    }
    return false;
}

/** Each rule: what it catches, and why that is feed UI. */
const RULES: readonly { name: string; pattern: RegExp | ((code: string) => boolean) }[] = [
    { name: 'renders publicationSources as rows', pattern: rendersPublicationSources },
    // Search hits' per-feed matches (the old L1 feed rows).
    { name: 'reads matchingSources', pattern: /\bmatchingSources\b/ },
    // One feed's article list.
    { name: 'asks for one feed\'s articles', pattern: /\b(?:get)?[Aa]rticlesForPublicationSource\b/ },
    // A feed URL on screen.
    { name: 'shows a feed URL', pattern: /\bfeed_url\b/ },
    // Navigation to the deleted feed-era screens (their route files are
    // redirect stubs; nothing may link to them).
    { name: 'navigates to a feed-era route', pattern: /['"`]\/logged-in\/(?:sources-articles|publisher-articles)\b/ },
];

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function listSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'worktrees') continue;
            out.push(...listSources(full));
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

export function feedUiViolations(src: string): string[] {
    const code = stripComments(src);
    return RULES.filter((r) => (typeof r.pattern === 'function' ? r.pattern(code) : r.pattern.test(code))).map(
        (r) => r.name,
    );
}

const FILES = SCAN_DIRS.flatMap((d) => listSources(path.join(ROOT, d)));

describe('no feed UI anywhere in the app', () => {
    it('scans a real, non-empty set of files', () => {
        // A derived list can only fail by being empty; say so.
        expect(FILES.length).toBeGreaterThan(100);
        expect(FILES.some((f) => f.endsWith('SourcesL2PublicationList.tsx'))).toBe(true);
    });

    it('finds no feed-list UI in any screen or component', () => {
        const offenders = FILES.flatMap((file) =>
            feedUiViolations(fs.readFileSync(file, 'utf8')).map((rule) => `${path.relative(ROOT, file)}: ${rule}`),
        );
        expect(offenders).toEqual([]);
    });
});

describe('the guard fires (each rule proven on a mutated real file)', () => {
    const l2 = fs.readFileSync(path.join(ROOT, 'components/custom/config-panel/SourcesL2PublicationList.tsx'), 'utf8');

    it('starts clean', () => {
        expect(feedUiViolations(l2)).toEqual([]);
    });

    it('catches feed rows rendered from publicationSources, arrow or block body', () => {
        const arrow = l2.replace(
            'return (\n                <PublicationListRow',
            'const feeds = item.publicationSources.map((feed) => <Text key={feed._id}>{feed.category}</Text>);\n            return (\n                <PublicationListRow',
        );
        expect(arrow).not.toBe(l2);
        expect(feedUiViolations(arrow)).toContain('renders publicationSources as rows');
        // The deleted accordion's exact shape: a block body that returns JSX.
        const block = `${l2}\nconst rows = item.publicationSources.map((feed) => {\n    const label = feed.category;\n    return (\n        <Pressable key={feed._id}><Text>{label}</Text></Pressable>\n    );\n});`;
        expect(feedUiViolations(block)).toContain('renders publicationSources as rows');
    });

    it('allows publicationSources read as DATA (the source names that key a preference)', () => {
        expect(l2).toMatch(/publicationSources/);
        expect(feedUiViolations(l2)).not.toContain('renders publicationSources as rows');
    });

    it('catches matchingSources, a per-feed article query, a feed URL and the old routes', () => {
        expect(feedUiViolations(`${l2}\nconst x = hit.matchingSources;`)).toContain('reads matchingSources');
        expect(feedUiViolations(`${l2}\nArticleService.getArticlesForPublicationSource(id);`)).toContain(
            'asks for one feed\'s articles',
        );
        expect(feedUiViolations(`${l2}\n<Text>{src.feed_url}</Text>;`)).toContain('shows a feed URL');
        expect(feedUiViolations(`${l2}\nrouter.push({ pathname: '/logged-in/sources-articles' });`)).toContain(
            'navigates to a feed-era route',
        );
        expect(feedUiViolations(`${l2}\nrouter.push('/logged-in/publisher-articles');`)).toContain(
            'navigates to a feed-era route',
        );
    });

    it('ignores a pattern that only appears in a comment', () => {
        expect(feedUiViolations(`${l2}\n// matchingSources used to render feed rows here`)).toEqual([]);
    });
});
