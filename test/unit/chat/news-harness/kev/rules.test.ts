import { classifyConsent, dropKnownFacts, dropUngrounded, existingIds, isKnownFact, negates, restates } from '@/lib/news-harness/on-device/kev';

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

  it.each(['no', 'No.', 'nope', 'nah', 'no thanks', 'no thank you', 'cancel', 'never mind', 'nevermind', 'don’t', 'not now', 'forget it', "don't do it", 'do not do that', "please don't", "no, don't", 'no, keep it', 'not yet', 'stop', 'no, leave it as it is'])(
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

  it('matches a restated fact written with a subject', () => {
    expect(isKnownFact('You live in Porto', known)).toBe(true);
    expect(isKnownFact('You work as a nurse', known)).toBe(true);
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

describe('restates', () => {
  // A stand-in for the owner's profile: a long location, a multi-word job, one-word interests.
  it.each([
    ['You live in Gràcia, Barcelona, Catalonia, Spain, EU', 'Lives in Gràcia, Barcelona, Catalonia, Spain, EU'],
    ['You are a founder building a solar energy startup', 'Founder building a solar energy startup'],
    ['You are interested in astronomy', 'Interested in astronomy'],
    ["You're interested in astronomy.", 'Interested in astronomy'],
    ['I am interested in astronomy', 'Interested in astronomy'],
    ['The user is interested in astronomy', 'Interested in astronomy'],
    ['User lives in Porto now', 'Lives in Porto'],
    ['Living in Gracia, Barcelona', 'Lives in Gràcia, Barcelona, Catalonia, Spain, EU'],
    ['Lives in Porto', 'Lives in Porto, Portugal'],
    ['Based in Porto', 'Lives in Porto, Portugal'],
    ['Resides in Porto', 'Lives in Porto'],
    ['Has two young kids', 'Has two young kids.'],
  ])('%p restates %p', (statement, saved) => {
    expect(restates(statement, saved)).toBe(true);
  });

  it.each([
    ['Interested in blockchain', 'Works in blockchain'],
    ['Lives in Amsterdam', 'Lives in Utrecht'],
    ['Lives in Noord, Amsterdam, North Holland, The Netherlands', 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands'],
    ['Lives in North Holland', 'Lives in South Holland'],
    ['Interested in local politics', 'Interested in local news'],
    ['Interested in AI safety', 'Interested in AI'],
    ['Lives in Brazil', 'From Brazil'],
    ['Has a dog', 'Afraid of dogs'],
    ['Interested in electric cars', 'Interested in electric vehicles'],
  ])('%p is not %p', (statement, saved) => {
    expect(restates(statement, saved)).toBe(false);
  });

  it('is false for an empty side', () => {
    expect(restates('', 'Lives in Porto')).toBe(false);
    expect(restates('You are', 'Lives in Porto')).toBe(false);
  });
});

describe('dropUngrounded', () => {
  const saved = ['Lives in Gràcia, Barcelona, Catalonia, Spain, EU', 'Founder building a solar energy startup', 'Works as a pharmacist'];

  it('drops a fact copied from the saved facts that the message never mentions', () => {
    const facts = [
      { statement: 'You live in Gràcia, Barcelona, Catalonia, Spain' },
      { statement: 'Runs a solar energy startup in Barcelona' },
      { statement: 'Interested in astronomy' },
    ];
    expect(dropUngrounded(facts, "I'm interested in astronomy", saved)).toEqual([
      { statement: 'Runs a solar energy startup in Barcelona' },
      { statement: 'Interested in astronomy' },
    ]);
  });

  it('keeps a fact in English for a message in another language', () => {
    expect(dropUngrounded([{ statement: 'Works as a teacher' }], 'Ich arbeite jetzt als Lehrer', saved)).toEqual([
      { statement: 'Works as a teacher' },
    ]);
    expect(dropUngrounded([{ statement: 'Sings in a choir' }], 'Ik zing sinds kort in een koor', saved)).toEqual([
      { statement: 'Sings in a choir' },
    ]);
  });

  it('keeps everything when nothing is saved yet', () => {
    expect(dropUngrounded([{ statement: 'Lives in Porto' }], 'hello', [])).toEqual([{ statement: 'Lives in Porto' }]);
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
      { statement: 'You live in Porto', attribute: 'residence' },
      { statement: 'You play chess', attribute: 'interest' },
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
