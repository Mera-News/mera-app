// The wait line's registry and the wait row's geometry. Read from the
// dictionaries on disk: a mocked translator would pass any key.
import fs from 'fs';
import path from 'path';
import {
  CHAT_PHASES,
  CHAT_PHASE_IDS,
  OPENING_PHASE_ID,
  chatPhaseDef,
  phaseLineHeight,
  waitRowHeight,
} from '@/components/custom/chat/chat-phases';
import { DEVICE_PHASE_ORDER } from '@/lib/services/chat-phase';

const LOCALES_DIR = path.join(__dirname, '../../../lib/locales');
const locales = fs
  .readdirSync(LOCALES_DIR)
  .filter((f) => /^[a-zA-Z-]+\.json$/.test(f))
  .map((f) => ({ lang: f.replace(/\.json$/, ''), dict: JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8')) }));
const en = locales.find((l) => l.lang === 'en')!.dict;

function read(dict: Record<string, unknown>, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), dict);
}
function lineOne(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

describe('the phase registry', () => {
  it('covers every phase id exactly once', () => {
    expect(CHAT_PHASES.map((p) => p.id).sort()).toEqual([...CHAT_PHASE_IDS].sort());
    for (const id of CHAT_PHASE_IDS) expect(chatPhaseDef(id).id).toBe(id);
  });

  it('every pool has a non-empty first line in every dictionary', () => {
    for (const { lang, dict } of locales) {
      for (const { phrasesKey } of CHAT_PHASES) {
        expect([lang, phrasesKey, lineOne(read(dict, phrasesKey)).trim().length > 0]).toEqual([lang, phrasesKey, true]);
      }
    }
  });

  it('the device pools and the opening pool claim nothing about encryption or a server', () => {
    // The opening pool also renders on device (the idle view).
    const honest = [...DEVICE_PHASE_ORDER, OPENING_PHASE_ID];
    for (const id of honest) {
      const pool = read(en, chatPhaseDef(id).phrasesKey);
      const lines = Array.isArray(pool) ? pool : [pool];
      for (const line of lines) expect(String(line)).not.toMatch(/encrypt|server|gateway|cloud|\bkey\b/i);
    }
  });

  it('line 1 of every pool fits the three reserved lines in every locale', () => {
    // ~40 characters a line at 15pt across the strip's 272pt, ~18 for CJK.
    const budget = (lang: string) => (/^(ja|zh)/.test(lang) ? 54 : lang === 'ko' ? 60 : 120);
    for (const { lang, dict } of locales) {
      for (const { phrasesKey } of CHAT_PHASES) {
        const length = [...lineOne(read(dict, phrasesKey))].length;
        expect([lang, phrasesKey, length <= budget(lang)]).toEqual([lang, phrasesKey, true]);
      }
    }
  });
});

describe('waitRowHeight', () => {
  const at = (showWords: boolean, engine: 'cloud' | 'local', textScale = 1, language = 'en') =>
    waitRowHeight({ showWords, engine, textScale, language });

  it('is 117 with words and 48 without on cloud, 58 on device, at 1x in English', () => {
    expect(at(true, 'cloud')).toBe(117);
    expect(at(false, 'cloud')).toBe(48);
    expect(at(true, 'local')).toBe(58);
    // On device the words always show; the flag changes nothing.
    expect(at(false, 'local')).toBe(58);
  });

  it('grows with the text scale and with a tall script', () => {
    expect(at(true, 'cloud', 1.3, 'hi')).toBeCloseTo(8 + 32 + 6 + 3 * 25 * 1.3 + 8);
    expect(at(true, 'local', 1.3, 'hi')).toBeCloseTo(16 + 2 * 25 * 1.3);
    // The strip alone does not grow: it never scales vertically.
    expect(at(false, 'cloud', 2)).toBe(48);
  });

  it('gives Devanagari, Thai and Arabic their taller line', () => {
    expect(phaseLineHeight('hi')).toBe(25);
    expect(phaseLineHeight('th')).toBe(25);
    expect(phaseLineHeight('ar')).toBe(24);
    expect(phaseLineHeight('pt-BR')).toBe(21);
    expect(phaseLineHeight('zh-TW')).toBe(21);
  });
});
