// The reason string's copy contract, enforced in the decoder.
//
// The reason is the only LLM-generated user-facing string in the feed, and
// house style has no em dashes. A prompt rule is advice a model can ignore;
// this is deterministic post-processing, and it is also the ONLY half of the
// fix that reaches the on-device path — the local reason prompt carries its own
// copy of the voice rule rather than sharing the cloud constant, so a cloud
// prompt rule cannot reach it but shared post-processing can.
//
// The interesting cases are all the ones where a dash is NOT clause
// punctuation. Those are what a naive global replace gets wrong, and each of
// them is a shape that really turns up in reasons.
import { parseReasonResponse } from '../article-pipeline/scoring';

const decode = (s: string) => parseReasonResponse(s, 'id');

describe('clause dashes become commas', () => {
  it('replaces a spaced em dash with a comma and one space', () => {
    expect(decode('Evacuation ordered in Jordaan — where you live.')).toBe(
      'Evacuation ordered in Jordaan, where you live.',
    );
  });

  it('replaces an unspaced em dash without gluing the words together', () => {
    // The failure this guards is "Jordaanwhere". Never concatenate.
    expect(decode('Evacuation ordered in Jordaan—where you live.')).toBe(
      'Evacuation ordered in Jordaan, where you live.',
    );
  });

  it('handles en dash and horizontal bar the same way', () => {
    expect(decode('Dutch tax vote – affects your startup work.')).toBe(
      'Dutch tax vote, affects your startup work.',
    );
    expect(decode('Dutch tax vote ― affects your startup work.')).toBe(
      'Dutch tax vote, affects your startup work.',
    );
  });

  it('handles several dashes in one sentence', () => {
    expect(decode('A — b — c.')).toBe('A, b, c.');
  });

  it('leaves a clean sentence untouched', () => {
    const clean = 'Dutch startup tax vote directly affects your Amsterdam startup work.';
    expect(decode(clean)).toBe(clean);
  });
});

describe('what is NOT clause punctuation', () => {
  it('leaves a numeric range alone, unspaced', () => {
    expect(decode('Rents rose over 2014–2016 in your city.')).toBe(
      'Rents rose over 2014–2016 in your city.',
    );
  });

  it('leaves a numeric range alone, spaced', () => {
    expect(decode('Rates of 10 – 15% affect your mortgage.')).toBe(
      'Rates of 10 – 15% affect your mortgage.',
    );
  });

  it('leaves hyphenated words alone', () => {
    // Hyphen-minus is not in the dash class at all: it is a real word joiner and
    // replacing it would corrupt ordinary prose.
    const s = 'On-device AI-industry news matches your work.';
    expect(decode(s)).toBe(s);
  });

  it('drops a leading dash rather than starting the sentence with a comma', () => {
    expect(decode('— Evacuation ordered in Jordaan.')).toBe(
      'Evacuation ordered in Jordaan.',
    );
  });

  it('drops a trailing dash rather than ending with a comma', () => {
    expect(decode('Evacuation ordered in Jordaan —')).toBe(
      'Evacuation ordered in Jordaan',
    );
  });

  it('never leaves a double space behind', () => {
    const out = decode('A  —  b.');
    expect(out).toBe('A, b.');
    expect(out).not.toMatch(/\s{2,}/);
  });

  it('never emits a space before a comma', () => {
    expect(decode('A — b — c.')).not.toMatch(/ ,/);
  });
});

describe('the 200-char cap cuts at a word boundary', () => {
  it('does not cut mid-word', () => {
    const long = `${'word '.repeat(60)}finalword`;
    const out = decode(long);
    expect(out.length).toBeLessThanOrEqual(200);
    // Every token that survived is a whole token.
    for (const token of out.split(' ')) {
      expect(['word', 'finalword']).toContain(token);
    }
  });

  it('leaves a short reason exactly as it is', () => {
    const short = 'Evacuation ordered in Jordaan, where you live.';
    expect(decode(short)).toBe(short);
  });

  it('adds no ellipsis — a cut is a failure, not a summary', () => {
    const out = decode('word '.repeat(60));
    expect(out).not.toMatch(/[.]{3}|…$/);
  });

  it('hard-cuts a single token longer than the cap rather than returning nothing', () => {
    const out = decode('x'.repeat(300));
    expect(out).toHaveLength(200);
  });

  it('never ends on trailing whitespace', () => {
    expect(decode('word '.repeat(60))).not.toMatch(/\s$/);
  });
});

describe('the pre-existing cleanup still works', () => {
  // These are not new behaviour. They are here because the dash replacement was
  // inserted into the middle of that chain, and a regression in the steps
  // around it would otherwise only show up in production copy.
  it('still strips markdown', () => {
    expect(decode('**Dutch tax vote** affects your work.')).toBe(
      'Dutch tax vote affects your work.',
    );
  });

  it('still strips an echoed score label', () => {
    expect(decode('Relevance Score: 0.62 Dutch tax vote affects your work.')).toBe(
      'Dutch tax vote affects your work.',
    );
  });

  it('still strips an echoed heading', () => {
    expect(decode('Why this matters to you: Dutch tax vote affects your work.')).toBe(
      'Dutch tax vote affects your work.',
    );
  });

  it('still unwraps a JSON string response', () => {
    expect(decode('"Dutch tax vote affects your work."')).toBe(
      'Dutch tax vote affects your work.',
    );
  });

  it('still unwraps a {reason} object', () => {
    expect(decode('{"reason":"Dutch tax vote — affects your work."}')).toBe(
      'Dutch tax vote, affects your work.',
    );
  });

  it('still returns empty for unusable output', () => {
    expect(decode('')).toBe('');
  });

  it('still collapses newlines to single spaces', () => {
    expect(decode('Dutch tax vote\n\naffects your work.')).toBe(
      'Dutch tax vote affects your work.',
    );
  });
});
