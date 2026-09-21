/* eslint-disable @typescript-eslint/no-require-imports */
import fs from 'node:fs';
import path from 'node:path';

import {
  HEADER_NARRATION_A11Y_KEY,
  HEADER_NARRATION_KEYS,
  HEADER_NARRATION_METRICS,
  HEADER_STAGE_POOL_IDS,
  NARRATION_CYCLE_MS,
  NARRATION_FADE_MS,
  NARRATION_HOLD_MS,
  NARRATION_TRANSITION_MS,
} from '../header-narration';

// COPY IS READ OFF DISK, NEVER THROUGH `t()`. The global i18n mock returns the
// key (or a default) for anything, so a `t()`-based copy test passes against a
// dictionary that does not contain the key at all. A file read cannot be faked.
const LOCALES_DIR = path.resolve(__dirname, '../../../../lib/locales');

const LOCALE_FILES = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort();

type Dict = Record<string, unknown>;

function read(locale: string): Dict {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale), 'utf8')) as Dict;
}

function lookup(dict: Dict, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (node, seg) =>
      node && typeof node === 'object' ? (node as Dict)[seg] : undefined,
    dict,
  );
}

/** Every rotating line in one locale, tagged with where it came from. */
function linesOf(locale: string): { key: string; index: number; text: string }[] {
  const dict = read(locale);
  const out: { key: string; index: number; text: string }[] = [];
  for (const key of Object.values(HEADER_NARRATION_KEYS)) {
    const pool = lookup(dict, key) as string[];
    pool.forEach((text, index) => out.push({ key, index, text }));
  }
  return out;
}

const DICTS = new Map(LOCALE_FILES.map((f) => [f, read(f)] as const));

describe('the twenty dictionaries carry the narration copy', () => {
  it('finds exactly twenty dictionaries', () => {
    // If this ever reads 19, every per-locale assertion below silently stops
    // covering the missing one.
    expect(LOCALE_FILES).toHaveLength(20);
    expect(LOCALE_FILES).toContain('en.json');
  });

  it('has every pool key, as a non-empty array of strings, in every locale', () => {
    const missing: string[] = [];
    for (const [locale, dict] of DICTS) {
      for (const key of Object.values(HEADER_NARRATION_KEYS)) {
        const pool = lookup(dict, key);
        if (!Array.isArray(pool) || pool.length === 0) {
          missing.push(`${locale}: ${key} is ${JSON.stringify(pool)}`);
          continue;
        }
        const bad = pool.findIndex((l) => typeof l !== 'string' || l.trim() === '');
        if (bad !== -1) missing.push(`${locale}: ${key}[${bad}] is not a usable string`);
      }
      if (typeof lookup(dict, HEADER_NARRATION_A11Y_KEY) !== 'string') {
        missing.push(`${locale}: ${HEADER_NARRATION_A11Y_KEY} is not a string`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has IDENTICAL pool lengths in every locale', () => {
    // The resolver hands out an unbounded cursor and the component wraps on the
    // pool's own length. Ragged lengths would make two locales sit on different
    // lines of the same run, which is how a short locale silently repeats.
    const en = Object.fromEntries(
      Object.entries(HEADER_NARRATION_KEYS).map(([id, key]) => [
        id,
        (lookup(DICTS.get('en.json')!, key) as string[]).length,
      ]),
    );
    const ragged: string[] = [];
    for (const [locale, dict] of DICTS) {
      for (const [id, key] of Object.entries(HEADER_NARRATION_KEYS)) {
        const n = (lookup(dict, key) as string[]).length;
        if (n !== en[id]) ragged.push(`${locale}: ${id} has ${n}, en has ${en[id]}`);
      }
    }
    expect(ragged).toEqual([]);
  });

  it('covers every pool the resolver can name, and names no pool it cannot', () => {
    expect(Object.keys(HEADER_NARRATION_KEYS).sort()).toEqual(
      [...HEADER_STAGE_POOL_IDS, 'nudges'].sort(),
    );
  });
});

describe('the copy fits the pinned two-line row', () => {
  // The row is height-pinned at 2 x 21 = 42pt against a 45pt title line box,
  // so a third line cannot appear: it would be clipped, not accommodated.
  // English is written to 46 and the other nineteen are allowed 58, which is
  // roughly the 25% that German and Italian run over English.
  const EN_CEILING = 46;
  const LOCALE_CEILING = 58;

  it('keeps every English line at or under its own tighter ceiling', () => {
    const over = linesOf('en.json')
      .filter((l) => l.text.length > EN_CEILING)
      .map((l) => `${l.key}[${l.index}] is ${l.text.length}: ${l.text}`);
    expect(over).toEqual([]);
  });

  it('keeps every line in every locale under the wrap budget', () => {
    const over: string[] = [];
    for (const locale of LOCALE_FILES) {
      for (const l of linesOf(locale)) {
        if (l.text.length > LOCALE_CEILING) {
          over.push(`${locale} ${l.key}[${l.index}] is ${l.text.length}: ${l.text}`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('the ceiling check can actually fail', () => {
    // A length assertion that has never been shown to fire is indistinguishable
    // from one measuring the wrong field.
    const longest = Math.max(
      ...LOCALE_FILES.flatMap((f) => linesOf(f).map((l) => l.text.length)),
    );
    expect(longest).toBeGreaterThan(40);
    expect(longest).toBeLessThanOrEqual(LOCALE_CEILING);
  });
});

describe('the house copy rules', () => {
  it('uses no em or en dashes anywhere, in any locale', () => {
    const bad: string[] = [];
    for (const locale of LOCALE_FILES) {
      for (const l of linesOf(locale)) {
        if (/[—–]/.test(l.text)) bad.push(`${locale} ${l.key}[${l.index}]: ${l.text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('interpolates nothing — these lines are shown as written', () => {
    const bad: string[] = [];
    for (const locale of LOCALE_FILES) {
      for (const l of linesOf(locale)) {
        if (l.text.includes('{{')) bad.push(`${locale} ${l.key}[${l.index}]: ${l.text}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ── THE HONESTY RULE ────────────────────────────────────────────────────────
// A line shown while scoring runs ON THE PHONE must not describe a round trip.
// The matcher carries the loanwords and native terms the twenty translations
// actually use, which is what gives it teeth outside English — verified by the
// positive control below, which fires in all twenty.
const OFFSITE =
  /server|cloud|network|upload|servidor|serveur|nuvem|nube|wolk|serwer|сервер|サーバ|서버|服务器|伺服器|เซิร์ฟเวอร์|sunucu|máy chủ|सर्वर|خادم/i;

const LOCAL_POOLS = ['starting', 'onDevice', 'nudges'] as const;

describe('on-device honesty', () => {
  it('never mentions a server, a cloud or an upload in a local-work pool', () => {
    const bad: string[] = [];
    for (const locale of LOCALE_FILES) {
      for (const l of linesOf(locale)) {
        const poolId = Object.entries(HEADER_NARRATION_KEYS).find(([, k]) => k === l.key)?.[0];
        if (!poolId || !(LOCAL_POOLS as readonly string[]).includes(poolId)) continue;
        if (OFFSITE.test(l.text)) bad.push(`${locale} ${l.key}[${l.index}]: ${l.text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('THE CONTROL: the same matcher fires on a cloud pool, in every locale', () => {
    // Without this, "no offsite word in the local pools" is satisfied just as
    // well by a matcher that cannot match anything in nineteen of the twenty.
    const silent: string[] = [];
    for (const locale of LOCALE_FILES) {
      const hit = linesOf(locale).some(
        (l) => l.key === HEADER_NARRATION_KEYS.downloading && OFFSITE.test(l.text),
      );
      if (!hit) silent.push(locale);
    }
    expect(silent).toEqual([]);
  });
});

describe('the nudges point away from the pipeline', () => {
  // Half of this pool exists to move attention off "is something new arriving?"
  // — the exact anticipation `7e96aa4` deleted the old cycling line to stop. A
  // nudge that narrates a pipeline step is just a stage line in the wrong slot.
  const PIPELINE_WORD = /analys|download|encrypt|group|summar/i;

  it('names no pipeline step in any English nudge', () => {
    const nudges = lookup(DICTS.get('en.json')!, HEADER_NARRATION_KEYS.nudges) as string[];
    expect(nudges.filter((n) => PIPELINE_WORD.test(n))).toEqual([]);
  });

  it('THE CONTROL: the same matcher fires on the English stage pools', () => {
    const stageLines = HEADER_STAGE_POOL_IDS.flatMap(
      (id) => lookup(DICTS.get('en.json')!, HEADER_NARRATION_KEYS[id]) as string[],
    );
    expect(stageLines.filter((l) => PIPELINE_WORD.test(l)).length).toBeGreaterThan(0);
  });
});

describe('the rhythm is derived, so the interval and the fade cannot drift', () => {
  it('derives the cycle from the hold and the transition', () => {
    expect(NARRATION_CYCLE_MS).toBe(NARRATION_HOLD_MS + NARRATION_TRANSITION_MS);
    expect(NARRATION_FADE_MS).toBe(NARRATION_TRANSITION_MS / 2);
  });

  it('holds each line longer than the chat wait line does', () => {
    // That line is watched; this one is glanced at above a list being scrolled.
    const { PHASE_LINE_HOLD_MS } = require('@/components/custom/chat/chat-phases');
    expect(NARRATION_HOLD_MS).toBeGreaterThan(PHASE_LINE_HOLD_MS);
  });

  it('budgets exactly two lines, and the row is pinned from the same numbers', () => {
    expect(HEADER_NARRATION_METRICS.maxLines).toBe(2);
    expect(
      HEADER_NARRATION_METRICS.lineHeight * HEADER_NARRATION_METRICS.maxLines,
    ).toBeLessThanOrEqual(45); // the `3xl` title line box, the smaller of the two
  });
});
