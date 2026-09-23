import { isPlainYes, narratesProcess } from '../prose';
import { attributeKey, isLocationKey, mayReplaceKey, sameAttributeKey } from '../fact-subject';
import { COMBINED_ORIGIN_KEY, isCombinedOriginFact, splitCombinedFact } from '../combined-fact';

describe('narratesProcess (precision first)', () => {
  // Every positive is a reply that reached a user on device or on the corpus.
  it.each([
    "I'll start by loading the appropriate skill for this turn.",
    'Let me check what you already follow, then I can offer this.',
    'Let me check for existing origin facts.',
    'I will look up Berlin first.',
    "I'm going to search for that now.",
  ])('fires on %p', (text) => {
    expect(narratesProcess(text)).toBe(true);
  });

  it.each([
    'Let me know what else you follow.',
    "I'll be here if you want to add more.",
    'Nieuw-West. One moment.',
    'Got it, the Champions League. Want me to add it?',
    'Nothing is stored about you yet.',
    'You live in Berlin, so I checked Berlin news for you.',
    // From the frozen G4 corpus: a conditional offer is a correct answer.
    "I don't have that on file. If you tell me where you live, I'll look up the place and save it.",
  ])('stays quiet on %p', (text) => {
    expect(narratesProcess(text)).toBe(false);
  });
});

describe('isPlainYes', () => {
  it.each(['Yes', 'yes please', 'Yes please add it.', 'Sure', 'ok', 'Go ahead', 'yep, thanks'])(
    'accepts %p',
    (t) => expect(isPlainYes(t)).toBe(true),
  );
  it.each(['yes, and I also follow F1', 'no', 'Yes I moved to Berlin last year with my family', ''])(
    'rejects %p',
    (t) => expect(isPlainYes(t)).toBe(false),
  );
});

describe('attribute keys', () => {
  it('compares the text before the colon', () => {
    expect(attributeKey('location: neighborhood/area, city, and country (preserve specifics)')).toBe('location');
    expect(sameAttributeKey('location: residence', 'Location: city')).toBe(true);
    expect(sameAttributeKey('location: residence', 'profession: x')).toBe(false);
    expect(sameAttributeKey(null, null)).toBe(false);
  });

  it('only a home fact may replace a home fact', () => {
    expect(isLocationKey('home: flat')).toBe(true);
    expect(mayReplaceKey(COMBINED_ORIGIN_KEY, 'location: residence')).toBe(false);
    expect(mayReplaceKey('location: city', 'location: residence')).toBe(true);
    expect(mayReplaceKey('profession: x', 'profession: y')).toBe(true);
    // No key says nothing, so it is not refused on key grounds.
    expect(mayReplaceKey(undefined, 'location: residence')).toBe(true);
  });
});

describe('splitCombinedFact', () => {
  it('splits the composed shape', () => {
    expect(splitCombinedFact('Expat from India living in Amsterdam, Netherlands, EU')).toEqual({
      origin: 'Expat from India',
      residence: 'Lives in Amsterdam, Netherlands, EU',
    });
    expect(splitCombinedFact('Expat from India, living in Nieuw West, Amsterdam.')).toEqual({
      origin: 'Expat from India',
      residence: 'Lives in Nieuw West, Amsterdam',
    });
  });

  it('leaves the no-city form alone', () => {
    expect(splitCombinedFact('Expat originally from India')).toBeNull();
  });

  it('recognises the combined key exactly', () => {
    expect(isCombinedOriginFact('background: origin and current residence')).toBe(true);
    expect(isCombinedOriginFact('background: country of origin')).toBe(false);
  });
});

describe('declaresNothingToAdd', () => {
  it.each([
    "That’s already on file, and no new specifics were added. I’ll leave your profile as it is.",
    "That's already in your profile.",
    'Nothing new to add there.',
  ])('fires on %p', (t) => expect(require('../prose').declaresNothingToAdd(t)).toBe(true));
  it('stays quiet on an offer', () => {
    expect(require('../prose').declaresNothingToAdd('Here it is to confirm.')).toBe(false);
  });
});
