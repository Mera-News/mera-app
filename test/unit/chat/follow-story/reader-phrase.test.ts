import {
  isCloseToPhrase,
  readerPhrase,
  withReaderPhrase,
} from '@/lib/news-harness/on-device/follow-story/reader-phrase';

const story = (label: string) => ({ label, search: `${label} search` });

describe('readerPhrase', () => {
  it.each([
    ['keep me updated on ajax feyenord match riots', 'ajax feyenord match riots'],
    ['Keep me posted about the dutch cabinet talks please', 'the dutch cabinet talks'],
    ["I'd like to follow the Artemis launch", 'the Artemis launch'],
    ['can you track Boeing strikes', 'Boeing strikes'],
    ['no, I meant the protests', 'the protests'],
    ['ajax feyenord match riots', 'ajax feyenord match riots'],
    ['track and field worlds', 'track and field worlds'],
    ['halte mich über die Wahl auf dem Laufenden', 'halte mich über die Wahl auf dem Laufenden'],
  ])('%s', (message, phrase) => {
    expect(readerPhrase(message)).toBe(phrase);
  });

  it.each(['', '   ', 'yes please', 'ok', 'thanks', 'follow this', 'yes, that one', 'keep me updated on it', 'that story', 'I want to follow a story', '!!!', 'x '.repeat(150)])(
    'names nothing: %j',
    (message) => {
      expect(readerPhrase(message)).toBeNull();
    },
  );
});

describe('isCloseToPhrase', () => {
  it.each([
    ['ajax feyenord match riots', 'Ajax Feyenoord match riots'],
    ['riots after ajax game', 'Riots after the Ajax game'],
    ['ajax feyenord match riots.', 'ajax feyenord match riots'],
    ['東京の選挙', '東京都の選挙'],
  ])('a fix: %s', (phrase, candidate) => {
    expect(isCloseToPhrase(phrase, candidate)).toBe(true);
  });

  it.each([
    ['ajax feyenord match riots', 'Ajax Feyenoord Hooligan Clashes'],
    ['ajax feyenord match riots', 'Ajax Feyenoord PSV match riots'],
    ['ajax feyenord match riots', 'Dutch football violence'],
    ['दिल्ली चुनाव', 'Delhi election'],
    ['東京の選挙', '大阪の知事選挙結果'],
  ])('a drift: %s to %s', (phrase, candidate) => {
    expect(isCloseToPhrase(phrase, candidate)).toBe(false);
  });
});

describe('withReaderPhrase', () => {
  const msg = 'keep me updated on ajax feyenord match riots';
  const fixed = story('Ajax Feyenoord match riots');

  it('exact, corrected, then stories, cut to the parser cap with neither phrase row evicted', () => {
    const card = withReaderPhrase([fixed, story('A'), story('B'), story('C')], msg, true)!;
    expect(card.options.map((o) => o.label)).toEqual([
      'ajax feyenord match riots',
      'Ajax Feyenoord match riots',
      'A',
      'B',
    ]);
    expect(card.options[0].search).toBe('ajax feyenord match riots');
    expect(card.hints.phraseRoles).toEqual({
      'ajax feyenord match riots': 'exact',
      'ajax feyenoord match riots': 'corrected',
    });
  });

  it('a case-only difference is one row: the corrected form', () => {
    const card = withReaderPhrase([story('Ajax feyenord match riots.'), story('A')], 'ajax feyenord match riots', true)!;
    expect(card.options.map((o) => o.label)).toEqual(['Ajax feyenord match riots.', 'A']);
    expect(card.hints.phraseRoles).toEqual({ 'ajax feyenord match riots.': 'corrected' });
    expect(card.hints.defaultTick).toBe('ajax feyenord match riots.');
  });

  it('demotes a drifted first option to a story option', () => {
    const card = withReaderPhrase([story('Dutch Hooligan Clashes'), story('A')], msg, true)!;
    expect(card.options.map((o) => o.label)).toEqual(['ajax feyenord match riots', 'Dutch Hooligan Clashes', 'A']);
    expect(card.hints.phraseRoles).toEqual({ 'ajax feyenord match riots': 'exact' });
  });

  it('finds the corrected option wherever the model put it', () => {
    const card = withReaderPhrase([story('A'), fixed], msg, true)!;
    expect(card.options.map((o) => o.label)).toEqual(['ajax feyenord match riots', 'Ajax Feyenoord match riots', 'A']);
  });

  it('ticks corrected, then exact for English only, then the first story', () => {
    expect(withReaderPhrase([fixed], msg, false)!.hints.defaultTick).toBe('ajax feyenoord match riots');
    const noFix = [story('A'), story('B')];
    expect(withReaderPhrase(noFix, msg, true)!.hints.defaultTick).toBe('ajax feyenord match riots');
    expect(withReaderPhrase(noFix, msg, false)!.hints.defaultTick).toBe('a');
    expect(withReaderPhrase(noFix, 'दिल्ली चुनाव', true)!.hints.defaultTick).toBe('a');
    expect(withReaderPhrase(noFix, 'Köln Wahl', true)!.hints.defaultTick).toBe('a');
  });

  it('adds nothing when the message names nothing or the model offered no option', () => {
    expect(withReaderPhrase([fixed], 'follow this', true)).toBeNull();
    expect(withReaderPhrase([fixed], '', true)).toBeNull();
    expect(withReaderPhrase([], msg, true)).toBeNull();
    expect(withReaderPhrase(undefined, msg, true)).toBeNull();
  });
});
