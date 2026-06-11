// Tests for questionnaire-data.ts — static data shape + builder functions.
// No mocks needed: this module is pure (no I/O, no native deps).

import {
  EXAMPLE_QUESTIONS,
  TOTAL_LEVELS,
  questionnaireLevels,
  isLocationAttribute,
  buildExampleQuestionsText,
  buildAttributeTextToIdMap,
  buildIdToAttributeTextMap,
  parseAttributeKey,
  getAttributeKeysForLevel,
  buildQuestionnaireGuide,
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

describe('TOTAL_LEVELS', () => {
  it('is 10', () => {
    expect(TOTAL_LEVELS).toBe(10);
  });

  it('matches the number of levels in questionnaireLevels', () => {
    expect(questionnaireLevels.length).toBe(TOTAL_LEVELS);
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

// ============================================================
// parseAttributeKey
// ============================================================

describe('parseAttributeKey', () => {
  it('extracts the key before the colon', () => {
    expect(parseAttributeKey('location: neighborhood/area, city')).toBe('location');
  });

  it('trims whitespace from the key', () => {
    expect(parseAttributeKey('  profession : job role')).toBe('profession');
  });

  it('returns the full string when there is no colon', () => {
    expect(parseAttributeKey('nokeyhere')).toBe('nokeyhere');
  });

  it('handles empty string', () => {
    expect(parseAttributeKey('')).toBe('');
  });

  it('uses only the FIRST colon position', () => {
    expect(parseAttributeKey('outer: inner: value')).toBe('outer');
  });
});

// ============================================================
// getAttributeKeysForLevel
// ============================================================

describe('getAttributeKeysForLevel', () => {
  it('returns the correct keys for level 1', () => {
    const keys = getAttributeKeysForLevel(1);
    expect(keys).toContain('location');
    expect(keys).toContain('profession');
    expect(keys).toContain('topics');
  });

  it('returns empty array for a non-existent level', () => {
    expect(getAttributeKeysForLevel(99)).toEqual([]);
    expect(getAttributeKeysForLevel(0)).toEqual([]);
  });

  it('returns the parsed keys (not the full attribute texts)', () => {
    const keys = getAttributeKeysForLevel(1);
    keys.forEach((k) => expect(k).not.toContain(':'));
  });

  it('returns correct count of keys for each level', () => {
    questionnaireLevels.forEach((l) => {
      expect(getAttributeKeysForLevel(l.level).length).toBe(l.attributes.length);
    });
  });
});

// ============================================================
// buildQuestionnaireGuide
// ============================================================

describe('buildQuestionnaireGuide', () => {
  it('returns empty string for a non-existent level', () => {
    expect(buildQuestionnaireGuide(99)).toBe('');
  });

  it('includes level number and category in header', () => {
    const guide = buildQuestionnaireGuide(1);
    expect(guide).toContain('Level 1:');
    expect(guide).toContain('Core');
  });

  it('marks all attributes as [ASK] when coveredAttributes is not provided', () => {
    const guide = buildQuestionnaireGuide(1);
    expect(guide).toContain('[ASK]');
    expect(guide).not.toContain('[DONE]');
  });

  it('marks covered attributes as [DONE] SKIP', () => {
    const covered = new Set(['location']);
    const guide = buildQuestionnaireGuide(1, covered);
    expect(guide).toContain('[DONE] SKIP');
  });

  it('marks uncovered attributes as [ASK]', () => {
    const covered = new Set(['location']); // only location covered
    const guide = buildQuestionnaireGuide(1, covered);
    expect(guide).toContain('[ASK]'); // profession/topics still [ASK]
  });

  it('marks all as [DONE] when all keys for the level are covered', () => {
    const level1Keys = getAttributeKeysForLevel(1);
    const allCovered = new Set(level1Keys);
    const guide = buildQuestionnaireGuide(1, allCovered);
    expect(guide).not.toContain('[ASK]');
    expect(guide).toContain('[DONE] SKIP');
  });

  it('marks all as [ASK] when covered set is empty', () => {
    const guide = buildQuestionnaireGuide(1, new Set());
    expect(guide).not.toContain('[DONE]');
    expect(guide).toContain('[ASK]');
  });

  it('produces a consistent multi-line format for level 2', () => {
    const guide = buildQuestionnaireGuide(2);
    expect(guide).toContain('Level 2:');
    expect(guide).toContain('Professional');
    // Each attribute on its own line
    const lines = guide.split('\n').filter((l) => l.startsWith('- '));
    const level2 = questionnaireLevels.find((l) => l.level === 2)!;
    expect(lines.length).toBe(level2.attributes.length);
  });
});
