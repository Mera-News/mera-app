import { isRelationalStatement, mayReplace } from '../fact-subject';

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
