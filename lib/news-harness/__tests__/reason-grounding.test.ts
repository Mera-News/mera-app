// The note-vs-article grounding check. The cases that matter are the two
// failure directions, and they are not symmetric: a FALSE NEGATIVE (a good note
// dropped) costs the user an explanation they earned plus a wasted LLM call,
// while a FALSE POSITIVE only leaves us where we already were. Most of these
// tests therefore pin the KEEP side.
import {
  groundingTokens,
  isReasonGrounded,
} from '../article-pipeline/reason-grounding';

// The article that motivated this whole change, verbatim.
const MP_WEATHER = {
  title:
    'MP Weather Update: 18% Less Rain in Madhya Pradesh, Drought-like Conditions in 49 Districts; IMD Alert for Next 3 Days',
  description:
    'The India Meteorological Department has issued an alert for the next three days as 49 districts report rainfall well below the seasonal average.',
};

// The note that was actually shown on it.
const AI_ACT_NOTE =
  "New AI Act rules on deepfakes directly impact your AI news app's compliance and content handling requirements.";

describe('groundingTokens', () => {
  it('lowercases, strips punctuation, and drops sub-3-character tokens', () => {
    // 'eu' / 'ai' / 'a' are all 2 characters or fewer and drop out; 'act'
    // survives at exactly 3, which is the intended floor.
    expect(groundingTokens('EU AI Act: a Ruling!')).toEqual(new Set(['act', 'ruling']));
  });

  it('keeps "act" but drops stopwords', () => {
    const tokens = groundingTokens('The new report says that they have said this');
    expect(tokens.has('report')).toBe(true);
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('new')).toBe(false);
    expect(tokens.has('says')).toBe(false);
  });

  it('folds plurals so districts and district are one token', () => {
    expect(groundingTokens('districts').has('district')).toBe(true);
    expect(groundingTokens('district').has('district')).toBe(true);
  });

  it('leaves short words ending in s alone', () => {
    expect(groundingTokens('gas').has('gas')).toBe(true);
  });

  it('returns an empty set for null, empty, and whitespace', () => {
    expect(groundingTokens(null).size).toBe(0);
    expect(groundingTokens(undefined).size).toBe(0);
    expect(groundingTokens('').size).toBe(0);
    expect(groundingTokens('   ').size).toBe(0);
  });

  it('yields nothing for non-Latin script rather than throwing', () => {
    expect(groundingTokens('मध्य प्रदेश मौसम').size).toBe(0);
  });
});

describe('isReasonGrounded — the reported defect', () => {
  it('rejects the AI-Act note on the MP rainfall article', () => {
    expect(isReasonGrounded(AI_ACT_NOTE, MP_WEATHER)).toBe(false);
  });

  it('keeps a note that names the article’s own subject', () => {
    expect(
      isReasonGrounded(
        'Drought conditions across Madhya Pradesh reach the districts where your family lives.',
        MP_WEATHER,
      ),
    ).toBe(true);
  });

  it('keeps a note grounded only in the description', () => {
    expect(
      isReasonGrounded('A meteorological alert covers your family’s state.', MP_WEATHER),
    ).toBe(true);
  });

  it('keeps a note grounded only through a plural fold', () => {
    // "district" (singular) vs the title's "Districts".
    expect(
      isReasonGrounded('Your parents’ district is among those affected.', MP_WEATHER),
    ).toBe(true);
  });
});

describe('isReasonGrounded — everything ambiguous resolves to keep', () => {
  it('accepts an empty or whitespace reason (nothing to police)', () => {
    expect(isReasonGrounded('', MP_WEATHER)).toBe(true);
    expect(isReasonGrounded('   ', MP_WEATHER)).toBe(true);
    expect(isReasonGrounded(null, MP_WEATHER)).toBe(true);
    expect(isReasonGrounded(undefined, MP_WEATHER)).toBe(true);
  });

  it('accepts a reason with no content tokens of its own', () => {
    // Every word is a stopword or too short — contentless, not wrong.
    expect(isReasonGrounded('This is for you and them.', MP_WEATHER)).toBe(true);
  });

  it('accepts any reason when the article carries no comparable text', () => {
    expect(isReasonGrounded(AI_ACT_NOTE, {})).toBe(true);
    expect(isReasonGrounded(AI_ACT_NOTE, { title: null, description: null })).toBe(true);
    expect(isReasonGrounded(AI_ACT_NOTE, { title: '', description: '   ' })).toBe(true);
  });

  it('accepts a reason grounded only in a server-tagged entity', () => {
    expect(
      isReasonGrounded('The Reserve Bank decision changes your mortgage rate.', {
        title: 'Rates held steady for a fourth quarter',
        entities: ['Reserve Bank'],
      }),
    ).toBe(true);
  });

  it('accepts a reason grounded only in a server-tagged place', () => {
    expect(
      isReasonGrounded('Flooding in Bhopal reaches your family.', {
        title: 'Heavy rain swamps low-lying areas',
        geoTags: ['Bhopal', 'Madhya Pradesh', 'IND'],
      }),
    ).toBe(true);
  });

  it('ignores an entity list that is empty or malformed', () => {
    expect(
      isReasonGrounded(AI_ACT_NOTE, { title: MP_WEATHER.title, entities: [], geoTags: [] }),
    ).toBe(false);
  });
});

describe('isReasonGrounded — the propagation case', () => {
  // A donor sentence about one story, checked against a sibling it was grouped
  // with. Grouping being union-find, this pairing is reachable transitively.
  const DONOR_REASON = 'The Hormuz closure raises what you pay at the pump in Amsterdam.';

  it('rejects the donor sentence on an unrelated sibling', () => {
    expect(isReasonGrounded(DONOR_REASON, MP_WEATHER)).toBe(false);
  });

  it('accepts it on a genuine sibling of the same story', () => {
    expect(
      isReasonGrounded(DONOR_REASON, {
        title: 'Shipping halted as Hormuz strait closure enters second week',
        description: 'Tanker traffic through the strait has stopped.',
      }),
    ).toBe(true);
  });
});
