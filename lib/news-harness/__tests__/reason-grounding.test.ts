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
  it('lowercases, strips punctuation, and keeps uppercase acronyms', () => {
    // 'EU' and 'AI' survive at two characters BECAUSE they are uppercase — they
    // are frequently the only terms a note and its article share. The lone 'a'
    // is one character and goes.
    expect(groundingTokens('EU AI Act: a Ruling!')).toEqual(
      new Set(['eu', 'ai', 'act', 'ruling']),
    );
  });

  it('drops two-letter function words, which are lowercase in real prose', () => {
    const tokens = groundingTokens('a study of rules in the EU on AI');
    expect(tokens.has('of')).toBe(false);
    expect(tokens.has('in')).toBe(false);
    expect(tokens.has('on')).toBe(false);
    expect(tokens.has('eu')).toBe(true);
    expect(tokens.has('ai')).toBe(true);
  });

  it('keeps two-digit numbers, which are content', () => {
    expect(groundingTokens('down 18 percent').has('18')).toBe(true);
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

// Every one of these was flagged as ungrounded by the first version of this
// check during a 292-article gold-set replay, and every one is a note that
// plainly IS about its article. They are the reason the check grew acronym
// handling and prefix matching, and they exist here so a future tightening has
// to face them.
describe('isReasonGrounded — false drops measured on the gold set', () => {
  it('matches regulate/regulation through the shared prefix', () => {
    expect(
      isReasonGrounded('EU AI regulation directly impacts your consumer app work in Amsterdam.', {
        title: 'The European Union launches new measures to regulate artificial intelligence',
        description: '',
      }),
    ).toBe(true);
  });

  it('matches on the acronyms alone when nothing else overlaps', () => {
    expect(
      isReasonGrounded('EU AI legislation affects your consumer app development in the region.', {
        title: 'After hacker attack, EU discusses AI laws with Anthropic and OpenAI',
        description: '',
      }),
    ).toBe(true);
  });

  it('matches a bare AI mention against an AI headline', () => {
    expect(
      isReasonGrounded(
        'Philosophical essay on AI regulation touches your technology interest, but offers no concrete change to your work.',
        { title: "Mince Can't Be Undone: Why It's Impossible to Limit AI", description: '' },
      ),
    ).toBe(true);
  });

  it('matches regulating/regulation across the inflection', () => {
    expect(
      isReasonGrounded(
        'UK AI regulation touches your interest, but it is foreign policy with no direct impact on your Amsterdam-based work.',
        { title: 'UK considers regulating AI if voluntary safeguards prove insufficient', description: '' },
      ),
    ).toBe(true);
  });

  it('still rejects the AI-Act note on the rainfall article, which shares neither', () => {
    // The acronyms that rescue the cases above are exactly what this article
    // does NOT contain — no 'AI', no 'EU', and no prefix reaching 'regulat'.
    expect(isReasonGrounded(AI_ACT_NOTE, MP_WEATHER)).toBe(false);
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
