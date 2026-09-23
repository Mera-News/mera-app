// The cleanup screen's own fallback copy follows the app's copy rules: no em or
// en dashes, and the one undo sentence the app uses everywhere. (The card body,
// `summary`, is generated in fact-hygiene.ts and is checked there.)
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, '../HygieneReviewScreen.tsx'), 'utf8');
const defaults = [...source.matchAll(/defaultValue:\s*(?:\n\s*)?'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);

describe('HygieneReviewScreen fallback copy', () => {
    it('finds the fallbacks it is checking', () => {
        expect(defaults.length).toBeGreaterThan(5);
    });

    it('has no em or en dash', () => {
        expect(defaults.filter((d) => /[—–]/.test(d))).toEqual([]);
    });

    it('says reversible things one way, once', () => {
        expect(defaults).toContain('You can undo this in the change log.');
        expect(defaults.filter((d) => /undo|reversible|restore/i.test(d))).toHaveLength(1);
    });
});
