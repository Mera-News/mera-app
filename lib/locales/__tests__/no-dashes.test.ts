// Copy rules for every value in all 20 dictionaries (owner rules):
//   - no em dash or en dash, in ANY locale (CJK, ru and uk included);
//   - no ';' and no '›': write two sentences, or "Open Settings, then …";
//   - never "open source" (the app is source-available, not open source);
//   - in the non-Latin locales the brand is written phonetically (ar ميرا,
//     hi मेरा, ja メラ, ko 메라, ru/uk Мера, th เมร่า, zh 梅拉). Latin "Mera"
//     survives only in the legal name "Mera Labs B.V.", a URL or an email.
// Every rule is a zero, not a ratchet: a new value either obeys it or fails here.
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve(__dirname, '..');
const NON_LATIN = new Set(['ar', 'hi', 'ja', 'ko', 'ru', 'uk', 'th', 'zh-CN', 'zh-TW']);
const KEEP_LATIN = /Mera Labs B\.V\.|https?:\/\/\S+|[\w.+-]*mera\.news\S*|[\w.+-]+@[\w.-]+/gi;

function leaves(obj: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (typeof obj === 'string') {
    out.push([prefix, obj]);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

const dictionaries = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''));

const values = (locale: string) =>
  leaves(JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')));

describe('locale copy rules', () => {
  it('finds all 20 dictionaries', () => {
    expect(dictionaries).toHaveLength(20);
  });

  it.each(dictionaries)('%s has no em dash, en dash, semicolon, › or →', (locale) => {
    const offenders = values(locale).filter(([, v]) => /[—–;›→]/.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it.each(dictionaries)('%s never says "open source"', (locale) => {
    const offenders = values(locale).filter(([, v]) => /open[ -]source/i.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it.each(dictionaries.filter((l) => NON_LATIN.has(l)))('%s writes the brand phonetically', (locale) => {
    const offenders = values(locale)
      .filter(([, v]) => /mera/i.test(v.replace(KEEP_LATIN, '')))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});
