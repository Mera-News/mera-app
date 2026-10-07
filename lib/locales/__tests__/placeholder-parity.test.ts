// No locale may use a {{placeholder}} that English does not, for the same key:
// the call site only supplies en's variables, so any other name renders its
// braces raw in that language only (th/vi `feed.statsPublished*_other` used
// {{articleWord}}, which no caller passes). A locale may use FEWER (Arabic's
// `_one` drops {{count}} and writes the word out), never different.
//
// A plural form is checked against the union of its English family (every
// form gets the same variables from the call site), which also covers forms en
// has no key for (Arabic's `_few`, `_many`, ...). Pending `_*-fragments.json` blocks are laid over each
// dictionary first, exactly as the splice applies them, so a fix waiting in a
// fragment counts and a regression introduced by one is caught.
import fs from 'fs';
import path from 'path';

const DIR = path.join(__dirname, '..');
const VAR = /\{\{\s*([A-Za-z0-9_]+)(?:\s*,[^}]*)?\s*\}\}/g;

type Tree = { [k: string]: string | Tree };
const flat = (t: Tree, p = '', out: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(t)) {
        const key = p ? `${p}.${k}` : k;
        if (typeof v === 'string') out[key] = v;
        else if (v && typeof v === 'object') flat(v as Tree, key, out);
    }
    return out;
};
const varsOf = (s: string) => new Set([...s.matchAll(VAR)].map((m) => m[1]));
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const dictionaries = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const fragments = fs.readdirSync(DIR).filter((f) => f.startsWith('_') && f.endsWith('-fragments.json')).sort();
const withFragments = (lang: string): Record<string, string> => {
    const merged = flat(read(`${lang}.json`));
    for (const f of fragments) {
        const block = read(f)[lang];
        if (block && typeof block === 'object') Object.assign(merged, flat(block));
    }
    return merged;
};

const en = withFragments('en');
const PLURAL = /_(zero|one|two|few|many|other)$/;

describe.each(dictionaries.filter((f) => f !== 'en.json').map((f) => f.replace('.json', '')))('%s placeholders', (lang) => {
    it('never uses a placeholder English does not have for the same key', () => {
        const loc = withFragments(lang);
        const bad: string[] = [];
        for (const [key, text] of Object.entries(loc)) {
            const lv = varsOf(text);
            if (lv.size === 0) continue;
            let ev: Set<string>;
            if (PLURAL.test(key)) {
                // A plural key is judged against its whole English FAMILY: the
                // call site passes the same variables to every form, so ru's
                // `_one` (which also covers 21, 31...) may print {{count}} where
                // en's `_one` says "once".
                const base = key.replace(PLURAL, '');
                const family = Object.keys(en).filter((k) => k.replace(PLURAL, '') === base && PLURAL.test(k));
                if (family.length === 0) continue;
                ev = new Set(family.flatMap((k) => [...varsOf(en[k])]));
            } else {
                if (en[key] === undefined) continue;
                ev = varsOf(en[key]);
            }
            const extra = [...lv].filter((v) => !ev.has(v));
            if (extra.length) bad.push(`${key}: {{${extra.join('}}, {{')}}} not in en`);
        }
        expect(bad).toEqual([]);
    });
});
