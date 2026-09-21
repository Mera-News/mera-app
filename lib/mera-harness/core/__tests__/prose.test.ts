import {
  claimsSaveHappened,
  cleanProse,
  collapseRepetitionLoop,
  leaksInternals,
  looksLikeSerialisedPayload,
  replaceClauseDashes,
  trailingQuestion,
} from '../prose';

describe('clause dashes', () => {
  it('replaces the measured failure shape with a comma', () => {
    // Verbatim from the agent corpus, where 25% of prose rows carried a dash
    // despite the router's explicit ban.
    expect(cleanProse('Confused by the statement — you said Berlin earlier.'))
      .toBe('Confused by the statement, you said Berlin earlier.');
  });

  it('handles em, en and horizontal bar', () => {
    for (const d of ['—', '–', '―']) {
      expect(cleanProse(`Got it${d}where next?`)).toBe('Got it, where next?');
    }
  });

  it('LEAVES DIGIT RANGES alone, whitespace included', () => {
    expect(cleanProse('Lived there 2014–2016.')).toBe('Lived there 2014–2016.');
    expect(cleanProse('About 10–15% of the time.')).toBe('About 10–15% of the time.');
    expect(replaceClauseDashes('2014 – 2016')).toBe('2014 – 2016');
  });

  it('never corrupts a HYPHEN, which is a word joiner and not in the class', () => {
    expect(cleanProse('You moved to Nieuw-West, on-device processing stays off.'))
      .toBe('You moved to Nieuw-West, on-device processing stays off.');
  });

  it('DROPS a leading or trailing dash rather than emitting a stray comma', () => {
    expect(cleanProse('— Got it.')).toBe('Got it.');
    expect(cleanProse('Got it —')).toBe('Got it');
  });

  it('never concatenates the two sides', () => {
    expect(replaceClauseDashes('a—b')).toBe('a, b');
  });

  it('collapses the double space the replacement would otherwise leave', () => {
    expect(cleanProse('Got it  —  where next?')).toBe('Got it, where next?');
  });

  it('is a no-op on clean prose and on empty input', () => {
    expect(cleanProse('Got it, where next?')).toBe('Got it, where next?');
    expect(cleanProse('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The router prompt must not MODEL the character it bans.
// ---------------------------------------------------------------------------
describe('the router prompt practises what it preaches', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildRouterPrompt } = require('../router-prompt');

  const surfaces = ['ONBOARDING', 'CONFIG'] as const;

  it.each(surfaces)('%s: no em or en dash outside the ban clause itself', (surface) => {
    const prompt: string = buildRouterPrompt({ surface, languageName: 'Dutch' });
    // The PUNCTUATION rule has to contain the characters in order to name them
    // and to show the counter-example, so it is the one exempt block. Strip it
    // and nothing else may carry one.
    const withoutBan = prompt
      .split('\n')
      .filter((l) => !/PUNCTUATION|The dash slips in most often|✗|✓/.test(l))
      .join('\n');
    const found = withoutBan.match(/[—–―]/g) ?? [];
    expect(found).toEqual([]);
  });

  it('the ban clause itself is still intact, so the strip above is not hiding a deletion', () => {
    const prompt: string = buildRouterPrompt({ surface: 'CONFIG' });
    expect(prompt).toContain('Never use an em dash');
    expect(prompt).toMatch(/[—]/); // the rule still demonstrates the character
  });
});

// ---------------------------------------------------------------------------
// The reply gate detectors, against the FROZEN G4 corpus.
//
// Every string here is a real final reply from the 2026-09-18 run, already
// cleaned the way the loop cleans it. Classified by hand from the run, not by
// the detector under test, so the test cannot pass by agreeing with itself.
// ---------------------------------------------------------------------------
import corpus from './fixtures/g4-reply-corpus.json';

describe('claimsSaveHappened', () => {
  it('fires on every measured false save claim', () => {
    const missed = corpus.claims.filter((s) => !claimsSaveHappened(s));
    expect(missed).toEqual([]);
    expect(corpus.claims.length).toBe(48);
  });

  // PRECISION IS THE POINT. A false positive costs a wasted leg AND rewrites a
  // sentence that was already correct; a false negative only leaves today's
  // behaviour. These all use save vocabulary and are all TRUE.
  it('never fires on a true statement that uses the same words', () => {
    const wrong = corpus.safe.filter((s) => claimsSaveHappened(s));
    expect(wrong).toEqual([]);
    expect(corpus.safe.length).toBe(25);
  });

  it('leaves the specific true sentences that motivated the allowlist', () => {
    for (const s of [
      "No facts are saved about you at all, there's nothing to delete.",
      'Nothing is stored about you yet, so there is nothing to delete.',
      'Your saved location is already Porto, Porto District, Portugal.',
      "Tap the ones you want to keep and they'll be saved.",
      "I don't have that on file, none of your saved facts include a home address.",
    ]) {
      expect(claimsSaveHappened(s)).toBe(false);
    }
  });

  // A POSITIVE CONTROL THAT MUST FAIL TO FIRE: a whole reply built only from
  // true sentences. If this ever fires the allowlist has been broken.
  it('does not fire on a reply assembled from allowlist sentences', () => {
    expect(claimsSaveHappened(corpus.safe.slice(0, 6).join(' '))).toBe(false);
  });

  // THE DASH FORM. Half the measured claims are written "Noted — ..." and the
  // loop shows the user the cleanProse'd text, so the gate runs on cleaned
  // input. The detector must reach the same verdict either way, or the two
  // punctuation styles would be policed differently.
  it('reaches the same verdict on the dash form and the cleaned form', () => {
    for (const raw of [
      'Noted — you follow the national football team.',
      "Got it — I've noted that.",
      'All set — your Porto residence and your work are both captured.',
    ]) {
      expect(claimsSaveHappened(raw)).toBe(true);
      expect(claimsSaveHappened(cleanProse(raw))).toBe(true);
    }
  });

  it('records the known misses rather than chasing them into false positives', () => {
    for (const s of corpus.knownMisses) expect(claimsSaveHappened(s)).toBe(false);
  });

  it('is quiet on ordinary replies and empty input', () => {
    expect(claimsSaveHappened('')).toBe(false);
    expect(claimsSaveHappened('Got it, Nieuw-West. What do you do for work?')).toBe(false);
  });
});

describe('leaksInternals', () => {
  it('detects every measured leak', () => {
    const missed = corpus.leaks.filter((s) => !leaksInternals(s));
    expect(missed).toEqual([]);
    expect(corpus.leaks.length).toBe(10);
  });

  it('detects each internal surface by itself', () => {
    expect(leaksInternals('The state notes I should read this as an answer.')).toBe(true);
    expect(leaksInternals('<state>Handling: residence.</state>')).toBe(true);
    expect(leaksInternals('I will call load_skill next.')).toBe(true);
    expect(leaksInternals('Loading facts/residence for this turn.')).toBe(true);
    expect(leaksInternals("I'll extract the fact about their residence.")).toBe(true);
    expect(leaksInternals('[assistant thinking] the user said Porto')).toBe(true);
  });

  it('does not fire on ordinary replies', () => {
    // The two classifications are INDEPENDENT: one corpus string makes no false
    // save claim (so it is `safe`) and still narrates the user in third person
    // (so it is a leak). Excluded by identity, never by loosening the detector.
    const leaks = new Set(corpus.leaks);
    for (const s of corpus.safe.filter((x) => !leaks.has(x))) {
      expect(leaksInternals(s)).toBe(false);
    }
    expect(leaksInternals('Got it, Porto. What do you do for work?')).toBe(false);
    expect(leaksInternals('')).toBe(false);
  });
});

describe('collapseRepetitionLoop', () => {
  // VERBATIM from the device, 2026-09-21: a conversation/correction turn whose
  // own reply was 1227 characters against a maximum of 183 on every other turn
  // of that session. Frozen rather than paraphrased, because the alternating
  // pair of closers is the shape a hand-written fixture would not have.
  const DEVICE_LOOP = [
    'Done. The chess fact is gone.',
    'I removed the chess hobby you had on file. Let me know if you need anything else.',
    'I removed the chess hobby you had on file. Let me know if there\u2019s anything else.',
    'I removed the chess hobby you had on file. Let me know if you need anything else.',
    'I removed the chess hobby you had on file. Let me know if there\u2019s anything else I can help with.',
    'I removed the chess hobby you had on file. Let me know if you need anything else.',
    'I removed the chess hobby you had on file. Let me',
  ].join('\n');

  it('cuts the measured loop at its first repeat', () => {
    expect(collapseRepetitionLoop(DEVICE_LOOP)).toBe(
      'Done. The chess fact is gone.\nI removed the chess hobby you had on file. Let me know if you need anything else.',
    );
  });

  it('leaves no truncated fragment behind', () => {
    // A de-duplication that kept the tail would end the reply mid-word. The
    // whole point of cutting rather than filtering is that it cannot.
    expect(collapseRepetitionLoop(DEVICE_LOOP).endsWith('Let me')).toBe(false);
  });

  it('reaches the loop through cleanProse, which is what the turn calls', () => {
    expect(cleanProse(DEVICE_LOOP).length).toBeLessThan(200);
  });

  // ---- the replies that must survive untouched ----

  it('leaves ordinary multi-sentence replies alone', () => {
    const kept = [
      'Got it, Nieuw-West. What do you do for work?',
      'Nieuw-West is a borough of Amsterdam, so it sits between the city and the wider area. I have added both readings. Pick the one that fits.',
      'You live in Porto. You work in AI. You follow Portuguese football.',
      'No facts are saved about you at all, there is nothing to delete.',
      'Tap the ones you want to keep and they will be saved. I can find more if none of these fit. Just say the word.',
    ];
    for (const text of kept) expect(collapseRepetitionLoop(text)).toBe(text);
  });

  it('does NOT fire on two sentences that merely start alike', () => {
    // Under six shared opening words, so the prefix rule cannot reach them.
    const text = 'You live in Porto. You live for football.';
    expect(collapseRepetitionLoop(text)).toBe(text);
  });

  it('needs a RUN: two sentences are never a loop', () => {
    const text = 'Got it. Got it.';
    expect(collapseRepetitionLoop(text)).toBe(text);
  });

  it('catches an exact repeat of a SHORT sentence once there is a run', () => {
    expect(collapseRepetitionLoop('Got it. Got it. Got it.')).toBe('Got it.');
  });

  it('folds punctuation and case, so a changed comma is still a repeat', () => {
    const text = [
      'Here is what I found for you today.',
      'Let me know if there is anything else I can help with.',
      'Let me know, if there is anything else I can help with!',
    ].join(' ');
    expect(collapseRepetitionLoop(text)).toBe(
      'Here is what I found for you today. Let me know if there is anything else I can help with.',
    );
  });

  it('works on a non-Latin script, which a [a-z] fold would silently skip', () => {
    const text = [
      '\u0413\u043e\u0442\u043e\u0432\u043e, \u044f \u0437\u0430\u043f\u043e\u043c\u043d\u0438\u043b \u044d\u0442\u043e.',
      '\u0414\u0430\u0439\u0442\u0435 \u0437\u043d\u0430\u0442\u044c, \u0435\u0441\u043b\u0438 \u043d\u0443\u0436\u043d\u043e \u0447\u0442\u043e-\u0442\u043e \u0435\u0449\u0451.',
      '\u0414\u0430\u0439\u0442\u0435 \u0437\u043d\u0430\u0442\u044c, \u0435\u0441\u043b\u0438 \u043d\u0443\u0436\u043d\u043e \u0447\u0442\u043e-\u0442\u043e \u0435\u0449\u0451.',
    ].join(' ');
    expect(collapseRepetitionLoop(text)).toBe(
      '\u0413\u043e\u0442\u043e\u0432\u043e, \u044f \u0437\u0430\u043f\u043e\u043c\u043d\u0438\u043b \u044d\u0442\u043e. \u0414\u0430\u0439\u0442\u0435 \u0437\u043d\u0430\u0442\u044c, \u0435\u0441\u043b\u0438 \u043d\u0443\u0436\u043d\u043e \u0447\u0442\u043e-\u0442\u043e \u0435\u0449\u0451.',
    );
  });

  it('is a no-op on empty and single-sentence input', () => {
    expect(collapseRepetitionLoop('')).toBe('');
    expect(collapseRepetitionLoop('Got it.')).toBe('Got it.');
  });
});

describe('a tool call written out as prose', () => {
  // VERBATIM from the device. The model emitted its saveExtractedFacts
  // arguments as TEXT and the bubble rendered them. The tool-name list missed
  // it completely: the payload names the ARGUMENTS, never the function.
  const RAW = `{
"extracted_user_information": [
{
"statement": "Interested in music festivals",
"questionnaire_attribute": "interests"
}
]
}`;

  it('is caught as a leak', () => {
    expect(leaksInternals(RAW)).toBe(true);
  });

  it('is caught structurally, not only by its key names', () => {
    // The names will always lag the model, so the shape has to carry it.
    expect(looksLikeSerialisedPayload('{"someKeyNobodyListed": 1}')).toBe(true);
    expect(looksLikeSerialisedPayload('[{"a": 1}]')).toBe(true);
  });

  it('leaves ordinary replies alone, including ones that mention a brace', () => {
    for (const ok of [
      'Got it, Nieuw-West. What do you do for work?',
      'I found Amsterdam, North Holland, The Netherlands, EU.',
      'Your code block starts with a { character, which is fine.',
      'Tap the ones you want to keep and they will be saved.',
    ]) {
      expect(looksLikeSerialisedPayload(ok)).toBe(false);
      expect(leaksInternals(ok)).toBe(false);
    }
  });

  it('needs a quoted key, so a bare brace is not a payload', () => {
    expect(looksLikeSerialisedPayload('{')).toBe(false);
    expect(looksLikeSerialisedPayload('{ just thinking out loud }')).toBe(false);
  });

  it('catches the argument keys on their own too', () => {
    expect(leaksInternals('I will put questionnaire_attribute on it.')).toBe(true);
    expect(leaksInternals('sending extracted_user_information now')).toBe(true);
  });
});
