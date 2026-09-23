// No em dashes or en dashes in user-facing copy (owner rule: they read as
// AI-written punctuation).
//
// English is held to zero. Other locales are a RATCHET, not a sweep: each one's
// count may only go down, and every value a `_ux1-*-fragments.json` file writes
// must be dash-free. ja, zh-CN, zh-TW, ru and uk are exempt because a dash is
// ordinary punctuation there (owner decision, ux1 Q10).
//
// Lower a baseline when a locale improves; never raise one.
import fs from 'node:fs';
import path from 'node:path';

const LOCALES_DIR = path.resolve(__dirname, '..');
const DASH = /[—–]/g;
const HAS_DASH = /[—–]/;
const EXEMPT = new Set(['ja', 'zh-CN', 'zh-TW', 'ru', 'uk']);

/** Dash occurrences per non-English locale, measured after the ux1 sweep. */
const BASELINE: Record<string, number> = {
  ar: 38, de: 47, es: 35, fr: 38, hi: 37, id: 38, it: 38, ko: 25, nl: 38,
  pl: 38, 'pt-BR': 38, th: 29, tr: 37, vi: 38,
};

/**
 * English keys still waiting for the chat scout's rewrite (it owns every
 * factCheck.* and floatingChat.* string). Delete entries as they land; the
 * list must only shrink.
 */
const EN_PENDING = new Set<string>([
  'factCheck.quickNothingFound',
  'factCheck.quickCouldNotSearch',
  'factCheck.quickArticleRequested',
  'factCheck.queued',
  'factCheck.stillChecking',
  'factCheck.checkedByUnavailable',
  'factCheck.checkedByMultipleNote',
  'factCheck.ownReadingHeading',
  'factCheck.actionA11yPending',
  'factCheck.actionA11yDone',
  'factCheck.noCitations',
  'factCheck.dashboard.empty',
  'factCheck.verdict.supported.detail',
  'factCheck.verdict.unsupported.detail',
  'floatingChat.aiInteractionNotice',
]);

/**
 * Fragment keys still carrying the OLD dashed translations in non-exempt
 * locales, waiting for their owner's corrected fragment. Keyed by fragment
 * file. Same contract as EN_PENDING: it may only shrink, and an entry whose
 * dashes are gone fails the next test until it is deleted here.
 */
const FRAGMENT_PENDING: Record<string, Set<string>> = {
  '_ux1-chat-fragments.json': new Set(EN_PENDING),
};

function leaves(obj: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (typeof obj === 'string') {
    out.push([prefix, obj]);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
}

const dictionaries = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => f.replace(/\.json$/, ''));

describe('locale dash rule', () => {
  it('finds all 20 dictionaries', () => {
    expect(dictionaries).toHaveLength(20);
  });

  it('English has no em or en dash outside the pending chat keys', () => {
    const offenders = leaves(read('en.json'))
      .filter(([k, v]) => HAS_DASH.test(v) && !EN_PENDING.has(k))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('every pending English key still exists and still needs the rewrite', () => {
    const en = new Map(leaves(read('en.json')));
    const stale = [...EN_PENDING].filter((k) => !(en.get(k) ?? '').match(DASH));
    // A key here that no longer has a dash must be removed from EN_PENDING.
    expect(stale).toEqual([]);
  });

  it.each(Object.keys(BASELINE))('%s does not gain dashes', (locale) => {
    const count = leaves(read(`${locale}.json`)).reduce(
      (n, [, v]) => n + (v.match(DASH)?.length ?? 0),
      0,
    );
    expect(count).toBeLessThanOrEqual(BASELINE[locale]);
  });

  it('every non-exempt locale has a baseline', () => {
    const missing = dictionaries.filter((l) => l !== 'en' && !EXEMPT.has(l) && !(l in BASELINE));
    expect(missing).toEqual([]);
  });

  it('ux1 fragments write no dashes outside exempt locales', () => {
    const fragments = fs.readdirSync(LOCALES_DIR).filter((f) => /^_ux1-.*-fragments\.json$/.test(f));
    const offenders: string[] = [];
    for (const file of fragments) {
      const frag = read(file) as Record<string, unknown>;
      const pending = FRAGMENT_PENDING[file] ?? new Set<string>();
      for (const [locale, body] of Object.entries(frag)) {
        if (locale === '_comment' || EXEMPT.has(locale)) continue;
        for (const [k, v] of leaves(body)) {
          if (HAS_DASH.test(v) && !pending.has(k)) offenders.push(`${file} ${locale} ${k}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every pending fragment key still needs its rewrite', () => {
    const stale: string[] = [];
    for (const [file, keys] of Object.entries(FRAGMENT_PENDING)) {
      if (!fs.existsSync(path.join(LOCALES_DIR, file))) {
        stale.push(`${file} (file gone)`);
        continue;
      }
      const frag = read(file) as Record<string, unknown>;
      const dashed = new Set<string>();
      for (const [locale, body] of Object.entries(frag)) {
        if (locale === '_comment' || EXEMPT.has(locale)) continue;
        for (const [k, v] of leaves(body)) if (HAS_DASH.test(v)) dashed.add(k);
      }
      for (const k of keys) if (!dashed.has(k)) stale.push(`${file} ${k}`);
    }
    // A key listed here that no longer carries a dash must be removed.
    expect(stale).toEqual([]);
  });
});
