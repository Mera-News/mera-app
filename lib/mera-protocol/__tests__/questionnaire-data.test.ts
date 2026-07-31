// Tests for questionnaire-data.ts — static data shape + builder functions.
// No mocks needed: this module is pure (no I/O, no native deps).

import {
  EXAMPLE_QUESTIONS,
  questionnaireLevels,
  isLocationAttribute,
  buildExampleQuestionsText,
  buildAttributeTextToIdMap,
  buildIdToAttributeTextMap,
  type QuestionnaireLevel,
  type QuestionnaireAttribute,
} from '../questionnaire-data';

// ============================================================
// Static data shape
// ============================================================

describe('EXAMPLE_QUESTIONS', () => {
  it('is a non-empty array of strings', () => {
    expect(Array.isArray(EXAMPLE_QUESTIONS)).toBe(true);
    expect(EXAMPLE_QUESTIONS.length).toBeGreaterThan(0);
    EXAMPLE_QUESTIONS.forEach((q) => expect(typeof q).toBe('string'));
  });

  it('contains at least 14 questions', () => {
    expect(EXAMPLE_QUESTIONS.length).toBeGreaterThanOrEqual(14);
  });

  it('starts with a location question', () => {
    expect(EXAMPLE_QUESTIONS[0].toLowerCase()).toContain('where do you live');
  });
});

describe('questionnaireLevels static data', () => {
  it('has exactly 10 levels', () => {
    expect(questionnaireLevels.length).toBe(10);
  });

  it('levels are numbered 1–10 in order', () => {
    questionnaireLevels.forEach((l, idx) => {
      expect(l.level).toBe(idx + 1);
    });
  });

  it('every level has a non-empty category string', () => {
    questionnaireLevels.forEach((l) => {
      expect(typeof l.category).toBe('string');
      expect(l.category.length).toBeGreaterThan(0);
    });
  });

  it('every attribute has a non-empty id and text', () => {
    for (const level of questionnaireLevels) {
      for (const attr of level.attributes) {
        expect(typeof attr.id).toBe('string');
        expect(attr.id.length).toBeGreaterThan(0);
        expect(typeof attr.text).toBe('string');
        expect(attr.text.length).toBeGreaterThan(0);
      }
    }
  });

  it('all attribute ids are unique across all levels', () => {
    const ids: string[] = questionnaireLevels.flatMap((l) => l.attributes.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('level 1 (Core) includes location, profession, topics attributes', () => {
    const level1 = questionnaireLevels.find((l) => l.level === 1)!;
    const texts = level1.attributes.map((a) => a.text);
    expect(texts.some((t) => t.includes('location'))).toBe(true);
    expect(texts.some((t) => t.includes('profession'))).toBe(true);
    expect(texts.some((t) => t.includes('topics'))).toBe(true);
  });

  it('level 10 (Fine-tuning) includes trusted_outlets and blocked_outlets', () => {
    const level10 = questionnaireLevels.find((l) => l.level === 10)!;
    const ids = level10.attributes.map((a) => a.id);
    expect(ids).toContain('q10_trusted_outlets');
    expect(ids).toContain('q10_blocked_outlets');
  });
});

// ============================================================
// isLocationAttribute
// ============================================================

describe('isLocationAttribute', () => {
  it('returns true for "location: ..." key', () => {
    expect(isLocationAttribute('location: neighborhood/area, city, and country')).toBe(true);
  });

  it('returns true for "neighborhood" key', () => {
    expect(isLocationAttribute('neighborhood: where they live locally')).toBe(true);
  });

  it('returns true for "residence" key', () => {
    expect(isLocationAttribute('residence: current address')).toBe(true);
  });

  it('returns true for "home" key', () => {
    expect(isLocationAttribute('home: primary home location')).toBe(true);
  });

  it('returns false for "profession" key', () => {
    expect(isLocationAttribute('profession: job role and industry')).toBe(false);
  });

  it('returns false for "company" key', () => {
    expect(isLocationAttribute('company: employer name')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLocationAttribute('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLocationAttribute('LOCATION: some place')).toBe(true);
    expect(isLocationAttribute('HOME: place')).toBe(true);
  });

  it('returns false for "family_locations" key (not a direct location key)', () => {
    expect(isLocationAttribute('family_locations: extended family locations')).toBe(false);
  });
});

// ============================================================
// buildExampleQuestionsText
// ============================================================

describe('buildExampleQuestionsText', () => {
  it('returns a non-empty string', () => {
    const text = buildExampleQuestionsText();
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('starts with "1. "', () => {
    expect(buildExampleQuestionsText().startsWith('1. ')).toBe(true);
  });

  it('contains as many numbered items as EXAMPLE_QUESTIONS entries', () => {
    const text = buildExampleQuestionsText();
    const lines = text.split('\n');
    expect(lines.length).toBe(EXAMPLE_QUESTIONS.length);
  });

  it('numbers items sequentially', () => {
    const text = buildExampleQuestionsText();
    EXAMPLE_QUESTIONS.forEach((q, i) => {
      expect(text).toContain(`${i + 1}. ${q}`);
    });
  });
});

// ============================================================
// buildAttributeTextToIdMap
// ============================================================

describe('buildAttributeTextToIdMap', () => {
  it('returns a Map with entries for every attribute', () => {
    const map = buildAttributeTextToIdMap();
    const allAttrs = questionnaireLevels.flatMap((l) => l.attributes);
    expect(map.size).toBe(allAttrs.length);
  });

  it('maps attribute text to the correct id', () => {
    const map = buildAttributeTextToIdMap();
    expect(map.get('location: neighborhood/area, city, and country (preserve specifics)')).toBe('q1_location');
  });

  it('returns a new map on each call (not shared state)', () => {
    const m1 = buildAttributeTextToIdMap();
    const m2 = buildAttributeTextToIdMap();
    expect(m1).not.toBe(m2);
  });
});

// ============================================================
// buildIdToAttributeTextMap
// ============================================================

describe('buildIdToAttributeTextMap', () => {
  it('returns a Map with entries for every attribute', () => {
    const map = buildIdToAttributeTextMap();
    const allAttrs = questionnaireLevels.flatMap((l) => l.attributes);
    expect(map.size).toBe(allAttrs.length);
  });

  it('maps id to the correct attribute text', () => {
    const map = buildIdToAttributeTextMap();
    expect(map.get('q1_location')).toBe('location: neighborhood/area, city, and country (preserve specifics)');
    expect(map.get('q10_trusted_outlets')).toBe('trusted_outlets: trusted news sources');
  });

  it('is the inverse of buildAttributeTextToIdMap', () => {
    const textToId = buildAttributeTextToIdMap();
    const idToText = buildIdToAttributeTextMap();
    for (const [text, id] of textToId) {
      expect(idToText.get(id)).toBe(text);
    }
  });
});
