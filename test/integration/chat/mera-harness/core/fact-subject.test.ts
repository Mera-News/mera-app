import { isNegativeInterest, isNotInterested, isRelationalStatement, isSeeLessOffer, mayReplace } from '@/lib/mera-harness/core/fact-subject';

describe('isRelationalStatement', () => {
  it('sees the people a persona talks about', () => {
    for (const s of [
      "My girlfriend's parents live in Porto Santo",
      'Parents live in Bhopal, Madhya Pradesh, India, Asia',
      'Wife works in publishing',
      'His brother coaches a youth team',
      'Kids go to school in Hoorn',
    ]) {
      expect(isRelationalStatement(s)).toBe(true);
    }
  });

  it('stays quiet on facts about the user', () => {
    for (const s of [
      'Lives in Amsterdam, North Holland, The Netherlands, EU',
      'Works as a software engineer',
      'Plays chess every weekend',
      'Expat from India',
      'Building an AI news app',
    ]) {
      expect(isRelationalStatement(s)).toBe(false);
    }
  });
});

describe('mayReplace', () => {
  // THE TESTFLIGHT CASE. "My girlfriend's parents live in Porto Santo"
  // resolved to Vila Baleira and was offered as a replacement for the user's
  // OWN home. A replace is a destroy: the fact and its topics go for good.
  it('refuses someone else’s fact replacing the user’s own', () => {
    expect(
      mayReplace(
        'Lives in Vila Baleira, Madeira, Portugal, EU',
        'Lives in Amsterdam, North Holland, The Netherlands, EU',
      ),
    ).toBe(true); // both non-relational: this pairing is a REAL move

    expect(
      mayReplace(
        "Girlfriend's parents live in Vila Baleira, Madeira, Portugal, EU",
        'Lives in Amsterdam, North Holland, The Netherlands, EU',
      ),
    ).toBe(false);
  });

  it('refuses it in the other direction too', () => {
    expect(
      mayReplace(
        'Lives in Amsterdam, North Holland, The Netherlands, EU',
        'Parents live in Bhopal, Madhya Pradesh, India, Asia',
      ),
    ).toBe(false);
  });

  it('allows a genuine correction of the SAME relational fact', () => {
    expect(
      mayReplace('Parents live in Bhopal, India', 'Parents live in Delhi, India'),
    ).toBe(true);
  });

  it('allows the user correcting their own move', () => {
    expect(
      mayReplace('Lives in Berlin, Germany, EU', 'Lives in Amsterdam, The Netherlands, EU'),
    ).toBe(true);
  });
});

describe('isNegativeInterest', () => {
  it.each([
    'No longer follows cricket news', 'Does not want celebrity gossip topics', 'Dislikes Bollywood content',
    'Prefers not to see celebrity gossip', 'Not interested in golf', 'No celebrity gossip', 'Mutes The Hindu',
    'Do not recommend or discuss Bollywood content', 'Does not want to hear about The Hindu',
    'Is not interested in golf', "Isn't interested in golf", 'Does not want The Hindu as a source',
    'Does not want to be shown anything about Bollywood', 'Prefers not to receive celebrity gossip',
  ])('"%s" is a stopped interest', (s) => expect(isNegativeInterest(s)).toBe(true));

  it.each([
    'No children', 'No longer lives in Paris', 'No longer works as a teacher', 'Does not drive',
    'Follows cricket', 'Prefers Dutch news', 'Interested in news about rail strikes',
    // Real facts that share a verb with a stopped interest (reviewer probe).
    'Does not want children', 'Does not like spicy food', 'Does not read German', 'Does not watch television',
    // A dislike or a "follow a(n)" with no interest word is a fact too (reviewer probe).
    'Dislikes spicy food', 'Avoids gluten', 'Hates cold weather', 'Blocks ads', 'Does not follow a religion',
    'Does not follow a diet',
  ])('"%s" is a fact', (s) => expect(isNegativeInterest(s)).toBe(false));
});

describe('isSeeLessOffer', () => {
  // Owner ruling: on a stop / less / mute / hide turn no negative or reduced
  // interest is ever a card, interest word or not (reviewer probe).
  it.each([
    'Does not want cricket', 'Does not want to see cricket', 'Does not watch cricket', 'Is not into cricket',
    'Not a fan of cricket', 'Does not care about cricket', 'Wants to see less cricket', 'Prefers less cricket coverage',
    'Stopped following cricket', 'Unfollowed cricket', 'Has no interest in cricket', 'Is no longer interested in F1',
    'Mutes The Hindu', 'Dislikes The Hindu', 'No longer follows cricket news',
  ])('"%s" is a see-less offer', (s) => expect(isSeeLessOffer(s)).toBe(true));
  it.each([
    'Lives in Berlin, Germany', 'No longer lives in Paris', 'Stopped working last year', 'Follows cricket',
    'Works as a nurse',
  ])('"%s" is not', (s) => expect(isSeeLessOffer(s)).toBe(false));
});

describe('isNotInterested', () => {
  // Owner ruling: "I'm not interested in X" is a fact, so this card is legit.
  it.each([
    'Not interested in golf', 'Is not interested in golf', "Isn't interested in golf", 'No longer interested in F1',
    'Is no longer interested in F1', 'Has no interest in cricket', 'No interest in cricket',
  ])(
    '"%s" is the not-interested fact', (s) => expect(isNotInterested(s)).toBe(true));
  it.each(['Does not want golf news', 'No longer follows golf', 'Interested in golf'])(
    '"%s" is not', (s) => expect(isNotInterested(s)).toBe(false));
});
