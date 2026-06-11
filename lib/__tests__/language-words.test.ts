import { LANGUAGE_WORDS, LANGUAGE_WORD_BY_CODE } from '../language-words';

describe('LANGUAGE_WORDS', () => {
  it('is an array', () => {
    expect(Array.isArray(LANGUAGE_WORDS)).toBe(true);
  });

  it('contains English "Language" as first entry', () => {
    expect(LANGUAGE_WORDS[0]).toBe('Language');
  });

  it('is non-empty and has at least 10 entries', () => {
    expect(LANGUAGE_WORDS.length).toBeGreaterThanOrEqual(10);
  });

  it('contains Arabic entry', () => {
    expect(LANGUAGE_WORDS).toContain('لغة');
  });

  it('contains Japanese entry', () => {
    expect(LANGUAGE_WORDS).toContain('言語');
  });

  it('all entries are non-empty strings', () => {
    for (const word of LANGUAGE_WORDS) {
      expect(typeof word).toBe('string');
      expect(word.length).toBeGreaterThan(0);
    }
  });
});

describe('LANGUAGE_WORD_BY_CODE', () => {
  it('is a plain object', () => {
    expect(typeof LANGUAGE_WORD_BY_CODE).toBe('object');
    expect(LANGUAGE_WORD_BY_CODE).not.toBeNull();
  });

  it('maps "en" to "Language"', () => {
    expect(LANGUAGE_WORD_BY_CODE['en']).toBe('Language');
  });

  it('maps "ar" to Arabic word', () => {
    expect(LANGUAGE_WORD_BY_CODE['ar']).toBe('لغة');
  });

  it('maps "de" to German word', () => {
    expect(LANGUAGE_WORD_BY_CODE['de']).toBe('Sprache');
  });

  it('maps "zh-CN" to simplified Chinese', () => {
    expect(LANGUAGE_WORD_BY_CODE['zh-CN']).toBe('语言');
  });

  it('maps "zh-TW" to traditional Chinese', () => {
    expect(LANGUAGE_WORD_BY_CODE['zh-TW']).toBe('語言');
  });

  it('maps "pt-BR" to Portuguese word', () => {
    expect(LANGUAGE_WORD_BY_CODE['pt-BR']).toBe('Idioma');
  });

  it('maps "es" to Spanish word', () => {
    expect(LANGUAGE_WORD_BY_CODE['es']).toBe('Idioma');
  });

  it('has keys for all major language codes', () => {
    const expectedCodes = ['en', 'ar', 'nl', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pl', 'ru', 'th', 'tr', 'uk', 'vi'];
    for (const code of expectedCodes) {
      expect(LANGUAGE_WORD_BY_CODE).toHaveProperty(code);
    }
  });

  it('all values are non-empty strings', () => {
    for (const [, value] of Object.entries(LANGUAGE_WORD_BY_CODE)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('LANGUAGE_WORDS array and LANGUAGE_WORD_BY_CODE values are consistent sets', () => {
    const mapValues = new Set(Object.values(LANGUAGE_WORD_BY_CODE));
    const arraySet = new Set(LANGUAGE_WORDS);
    // Every unique value in the map should appear in the array
    for (const val of mapValues) {
      expect(arraySet).toContain(val);
    }
  });
});
