import { classifyConsent, dropKnownFacts, existingIds, isKnownFact, negates } from '@/lib/news-harness/on-device/kev';

describe('classifyConsent', () => {
  it.each(['yes', 'Yes!', 'yeah', 'sure', 'do it', 'Go ahead.', 'please do', 'apply it', 'yes please', 'yes, thanks', 'ok, do it', 'okay go ahead', 'Sure thing'])(
    '%p applies',
    (text) => {
      expect(classifyConsent(text)).toBe('apply');
    },
  );

  it.each(['ok', 'OK', 'okay', 'cool', 'thanks', 'Thank you!', 'nice', 'great', 'hmm', 'ok thanks', 'cool, thanks', 'got it'])(
    '%p only acknowledges',
    (text) => {
      expect(classifyConsent(text)).toBe('acknowledge');
    },
  );

  it.each(['no', 'No.', 'nope', 'nah', 'no thanks', 'no thank you', 'cancel', 'never mind', 'nevermind', 'don’t', 'not now', 'forget it', "don't do it", 'do not do that', "please don't", "no, don't", 'no, keep it', 'not yet', 'stop'])(
    '%p declines',
    (text) => {
      expect(classifyConsent(text)).toBe('decline');
    },
  );

  it.each(['', '   ', 'yes, and I also follow F1', 'no problem, go ahead', 'sure, why not', 'keep it', 'please', 'ja', 'what does this do?', 'I live in Porto'])(
    '%p defers to Kev',
    (text) => {
      expect(classifyConsent(text)).toBe('none');
    },
  );

  it('normalises spacing and trailing punctuation', () => {
    expect(classifyConsent('  go   ahead !! ')).toBe('apply');
  });
});

describe('negates', () => {
  it.each(["no wait, don't apply that yet", 'hold on', 'yes but not now', 'Never mind that', 'I do not want it'])('%p says no', (text) => {
    expect(negates(text)).toBe(true);
  });

  it.each(['yes, add that one', 'go ahead', 'I know about it', 'notes are fine', 'nothing else, apply it', 'no problem, go ahead', 'no worries, do it', 'sure, why not', 'not bad'])('%p does not', (text) => {
    expect(negates(text)).toBe(false);
  });
});

describe('isKnownFact', () => {
  const known = ['Lives in Porto', 'The user works as a nurse'];

  it('matches a restated fact regardless of case, articles and punctuation', () => {
    expect(isKnownFact('lives in porto.', known)).toBe(true);
    expect(isKnownFact('Works as a Nurse', known)).toBe(true);
  });

  it('does not match a different fact', () => {
    expect(isKnownFact('Lives in Lisbon', known)).toBe(false);
  });

  it('is false for an empty statement or no facts', () => {
    expect(isKnownFact('', known)).toBe(false);
    expect(isKnownFact('...', known)).toBe(false);
    expect(isKnownFact('Lives in Porto', [])).toBe(false);
  });
});

describe('dropKnownFacts', () => {
  it('drops restated, repeated and empty facts and keeps order and extra fields', () => {
    const facts = [
      { statement: 'Lives in Porto', attribute: 'residence' },
      { statement: 'Plays chess', attribute: 'interest' },
      { statement: 'plays chess!', attribute: 'interest' },
      { statement: '  ', attribute: 'interest' },
      { statement: 'Has two kids', attribute: 'family' },
    ];
    expect(dropKnownFacts(facts, ['lives in porto'])).toEqual([
      { statement: 'Plays chess', attribute: 'interest' },
      { statement: 'Has two kids', attribute: 'family' },
    ]);
  });

  it('keeps everything with no known facts, and returns nothing for no facts', () => {
    expect(dropKnownFacts([{ statement: 'Plays chess' }], [])).toEqual([{ statement: 'Plays chess' }]);
    expect(dropKnownFacts([], ['Lives in Porto'])).toEqual([]);
  });
});

describe('existingIds', () => {
  it('keeps only known ids, each once, in the given order', () => {
    expect(existingIds(['b', 'x', 'a', 'b'], new Set(['a', 'b']))).toEqual(['b', 'a']);
  });

  it('takes any iterable and handles empty inputs', () => {
    expect(existingIds(['a'], ['a', 'c'])).toEqual(['a']);
    expect(existingIds([], ['a'])).toEqual([]);
    expect(existingIds(['a'], [])).toEqual([]);
  });
});
