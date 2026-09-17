// Pass 2 now emits a SCORE alongside the reason, and that score replaces pass
// 1's. These tests pin the two halves failing in OPPOSITE directions, which is
// the whole design:
//
//   - the SCORE fails open. A legacy string, a `{reason}` object, a truncated
//     object, a non-numeric `s`, an invented `k` — every one of them leaves the
//     pass-1 score standing. Nothing here may ever demote on a decode failure.
//   - the REASON fails closed, exactly as it did before: the reasoning-trace
//     rejection, the deliberation-opener rejection and the names-a-score
//     rejection all still yield an empty reason.
//
// THE CASE THAT CAN SHIP A VISIBLE DEFECT, and the reason this file exists at
// all, is the TRUNCATED object. `reasonMaxTokens` is 96 and the headline reason
// may run to 35 words, so a response cut mid-sentence is a live outcome, not a
// thought experiment. Cut inside the `reason` string it fails `JSON.parse` and
// arrives at the bare-decimal rule as raw text carrying a visible `"s":0.62`,
// where that rule rejects it. If the bare-decimal rule were ever moved to run
// only on an extracted `reason` FIELD, that same string would be stripped of
// its punctuation, collapsed, and persisted as the card's "why this matters to
// you". It reads almost like a sentence, which is what makes it dangerous.
import {
  applyRescorePolicy,
  bucketScore,
  bucketScores,
  decodeCloudBatchResults,
  newReasonDecodeStats,
  parseBatchRelevanceResponse,
  parseReasonResponse,
  parseReasonResult,
} from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';

const decode = (out: string) => parseReasonResult(out, 'id');

const REASON = 'Evacuation ordered in Jordaan, where you live.';

describe('the object contract', () => {
  it('returns the reason and the score from one object', () => {
    const { reason, rescore } = decode(
      `{"k":"home","s":0.62,"reason":${JSON.stringify(REASON)}}`,
    );
    expect(reason).toBe(REASON);
    expect(rescore).toEqual({ k: 'home', s: 0.62, score: 0.62 });
  });

  it('clamps `s` into the band its own `k` declares, in both directions', () => {
    // `none` is [0.05, 0.24]; the model says `none` and then scores it 0.71.
    expect(decode('{"k":"none","s":0.71,"reason":"x y z"}').rescore?.score).toBe(0.24);
    // `home` is [0.40, 1.10]; a `home` scored 0.12 comes up to the floor.
    expect(decode('{"k":"home","s":0.12,"reason":"x y z"}').rescore?.score).toBe(0.4);
  });

  it('accepts an object carrying a score and no reason', () => {
    const { reason, rescore } = decode('{"k":"interest","s":0.31}');
    expect(reason).toBe('');
    expect(rescore?.score).toBe(0.31);
  });

  it('unwraps a markdown-fenced object', () => {
    const { reason, rescore } = decode(
      '```json\n{"k":"domain","s":0.68,"reason":"A plain sentence about your work."}\n```',
    );
    expect(reason).toBe('A plain sentence about your work.');
    expect(rescore?.score).toBe(0.68);
  });

  it('reads the object that follows a leaked reasoning trace', () => {
    const { reason, rescore } = decode(
      'weighing the stake here</think>{"k":"none","s":0.14,"reason":"A foreign domestic vote, no tie to your country."}',
    );
    expect(reason).toBe('A foreign domestic vote, no tie to your country.');
    expect(rescore?.score).toBe(0.14);
  });

  it('still converts an em dash inside the reason FIELD to a comma', () => {
    // The field goes through the same strip/cap chain as a plain string did, so
    // house style reaches the object path for free.
    expect(
      decode('{"k":"home","s":0.9,"reason":"Drought rules start Monday — where you live."}')
        .reason,
    ).toBe('Drought rules start Monday, where you live.');
  });
});

describe('the score fails OPEN — every one of these leaves pass 1 standing', () => {
  it.each([
    ['a legacy plain string', 'Dutch tax vote affects your Amsterdam work.'],
    ['a legacy {reason} object', '{"reason":"Dutch tax vote affects your Amsterdam work."}'],
    ['a non-numeric `s`', '{"k":"home","s":"high","reason":"Dutch tax vote affects your work."}'],
    ['a missing `s`', '{"k":"home","reason":"Dutch tax vote affects your work."}'],
    ['an invented `k`', '{"k":"vibes","s":0.62,"reason":"Dutch tax vote affects your work."}'],
  ])('%s carries no rescore, and the reason still decodes', (_label, output) => {
    const { reason, rescore } = decode(output);
    expect(rescore).toBeUndefined();
    expect(reason.length).toBeGreaterThan(0);
  });

  it('a JSON ARRAY is neither a reason nor a rescore', () => {
    // The relevance pass answers in arrays; the reason pass does not. An array
    // here means the model answered the wrong question, so there is nothing to
    // salvage — and the bare-decimal rule is what stops the raw array text
    // reaching the card, exactly as it did before the object contract existed.
    expect(decode('[{"k":"home","s":0.62}]')).toEqual({ reason: '' });
  });

  it('an invented `k` does NOT fall back to a plain 0-1.1 clamp', () => {
    // `clampToStakeBand` returns clampRelevance(s) for an unknown tag, which
    // would let a made-up tag put 1.09 on a row with no band to hold it. The
    // rescore is refused outright instead.
    expect(decode('{"k":"catastrophe","s":1.09,"reason":"x y z"}').rescore).toBeUndefined();
  });
});

describe('the reason fails CLOSED, unchanged', () => {
  it('rejects a reason that names its score to the reader, and KEEPS the rescore', () => {
    const { reason, rescore } = decode(
      '{"k":"home","s":0.68,"reason":"Dutch tax vote, warranting a high feed score."}',
    );
    expect(reason).toBe('');
    expect(rescore?.score).toBe(0.68);
  });

  it.each([
    ['an unclosed reasoning trace', '<think>weighing this up'],
    ['a deliberation opener', 'Let me analyze this article for the user'],
  ])('%s yields no reason and no rescore', (_label, output) => {
    expect(decode(output)).toEqual({ reason: '' });
  });

  it('REJECTS a TRUNCATED object rather than persisting its raw JSON', () => {
    // Cut mid-sentence inside `reason`. `JSON.parse` fails, so this reaches the
    // bare-decimal rule as raw text with a visible 0.62 in it.
    const truncated = '{"k":"home","s":0.62,"reason":"Parliament\'s delay on parental leave';
    const { reason, rescore } = decode(truncated);
    expect(reason).toBe('');
    expect(rescore).toBeUndefined();
  });

  it('a truncated object never leaks its field names into a persisted reason', () => {
    const truncated = '{"k":"family","s":0.55,"reason":"Porto Santo ferry cuts start';
    expect(decode(truncated).reason).not.toMatch(/reason|"k"|"s"/);
  });
});

describe('the bare-decimal rule applies to the reason FIELD only', () => {
  it('does not reject a well-formed object just because `s` is a bare decimal', () => {
    // The whole response contains `0.62`. Run the rule over the RESPONSE and
    // this reason dies; run it over the extracted field and it lives.
    expect(decode(`{"k":"home","s":0.62,"reason":${JSON.stringify(REASON)}}`).reason).toBe(
      REASON,
    );
  });

  it('still rejects a bare decimal the model wrote INTO the sentence', () => {
    expect(
      decode('{"k":"home","s":0.62,"reason":"Dutch tax vote, a 0.62 match for your work."}')
        .reason,
    ).toBe('');
  });

  it('still allows a real percentage in the sentence', () => {
    const withPercent = 'A 0.5% rate cut lands on the mortgage you hold in Amsterdam.';
    expect(decode(`{"k":"home","s":0.85,"reason":${JSON.stringify(withPercent)}}`).reason).toBe(
      withPercent,
    );
  });
});

describe('decode stats', () => {
  it('counts applied, unparsed and band violations separately', () => {
    const stats = newReasonDecodeStats();
    parseReasonResult('{"k":"home","s":0.62,"reason":"a b c"}', 'id', undefined, undefined, stats);
    parseReasonResult('{"k":"none","s":0.90,"reason":"a b c"}', 'id', undefined, undefined, stats);
    parseReasonResult('A legacy plain string reason.', 'id', undefined, undefined, stats);
    parseReasonResult('{"k":"nope","s":0.5,"reason":"a b c"}', 'id', undefined, undefined, stats);

    expect(stats.rescoreApplied).toBe(2);
    expect(stats.rescoreUnparsed).toBe(2);
    expect(stats.rescoreBandViolations).toBe(1);
    // 0.90 against a `none` ceiling of 0.24.
    expect(stats.rescoreBandViolationMass).toBeCloseTo(0.66, 10);
  });
});

describe('parseReasonResponse — the string-only wrapper', () => {
  it('keeps its signature and returns the sentence', () => {
    expect(parseReasonResponse('{"k":"home","s":0.62,"reason":"A plain one."}', 'id')).toBe(
      'A plain one.',
    );
    expect(parseReasonResponse('A legacy plain string.', 'id')).toBe('A legacy plain string.');
  });
});

describe('decodeCloudBatchResults', () => {
  const empty = { promptsById: new Map<string, string>(), chunkIdToCandidates: new Map() };

  it('fills rescoreMap SPARSELY, only where a score parsed', () => {
    const { reasonMap, rescoreMap } = decodeCloudBatchResults({
      ...empty,
      batchResults: [
        { id: 'reason:a', output: '{"k":"home","s":0.62,"reason":"A rescored one."}' },
        { id: 'reason:b', output: 'A legacy plain string one.' },
        { id: 'reason:c', output: '', error: 'transport failed' },
      ],
    });

    expect(rescoreMap.get('a')).toBe(0.62);
    expect(rescoreMap.has('b')).toBe(false);
    expect(rescoreMap.has('c')).toBe(false);
    expect(reasonMap.get('b')).toBe('A legacy plain string one.');
    expect(reasonMap.get('c')).toBe('');
  });

  it('never writes a rescore into scoreMap', () => {
    // Pass 1's score is the only record of what the batched filter said, and
    // the eval compares the two. Overwriting it would destroy the comparison.
    const { scoreMap } = decodeCloudBatchResults({
      ...empty,
      batchResults: [
        { id: 'reason:a', output: '{"k":"home","s":0.62,"reason":"A rescored one."}' },
      ],
    });
    expect(scoreMap.size).toBe(0);
  });
});

describe('applyRescorePolicy', () => {
  it('replaces by default, in BOTH directions', () => {
    // Pass 2 sees one article where pass 1 saw five, on the same rubric and the
    // same facts. Its answer is the better-informed one whichever way it moves.
    expect(applyRescorePolicy(0.8, 0.16)).toBe(0.16);
    expect(applyRescorePolicy(0.42, 0.91)).toBe(0.91);
  });

  it('demote-only ignores an increase', () => {
    expect(applyRescorePolicy(0.8, 0.16, 'demote-only')).toBe(0.16);
    expect(applyRescorePolicy(0.42, 0.91, 'demote-only')).toBe(0.42);
    // Equal is not an increase; either branch returns the same number.
    expect(applyRescorePolicy(0.5, 0.5, 'demote-only')).toBe(0.5);
  });
});

describe('bucketScore', () => {
  const cfg = DEFAULT_HARNESS_CONFIG.articlePipeline;

  it('agrees with bucketScores on every value', () => {
    // The single-value form exists so the per-row rescore write does not need a
    // second copy of the four cutoffs. It has to stay the same rule.
    const values = [0, 0.16, 0.39, 0.4, 0.55, 0.6, 0.79, 0.8, 0.99, 1.0, 1.05, 1.1];
    const map = new Map(values.map((v, i) => [String(i), v]));
    bucketScores(map, cfg);
    values.forEach((v, i) => expect(bucketScore(v, cfg)).toBe(map.get(String(i))));
  });

  it('returns a sub-floor score untouched', () => {
    expect(bucketScore(0.16, cfg)).toBe(0.16);
    expect(bucketScore(0.39, cfg)).toBe(0.39);
  });
});

describe('pass-1 stake tags', () => {
  const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
  const decodeScores = (out: string, n: number, tags?: (string | null)[]) =>
    parseBatchRelevanceResponse(out, n, 'id', undefined, CFG, undefined, undefined, tags);

  it('reports the tag the model used, aligned with the scores', () => {
    // THE MEASUREMENT THIS EXISTS FOR. `home`, `family`, `travel`, `domain` and
    // `attend` all clamp into [0.40, 1.10], so "was this foreign-domestic story
    // tagged `home`?" cannot be read off the score. Only `k` answers it.
    const tags: (string | null)[] = [];
    const scores = decodeScores(
      '[{"k":"home","s":0.82},{"k":"none","s":0.12},{"k":"interest","s":0.33}]',
      3,
      tags,
    );
    expect(scores).toEqual([0.82, 0.12, 0.33]);
    expect(tags).toEqual(['home', 'none', 'interest']);
  });

  it('reports null for a legacy bare-number entry, keeping the arrays aligned', () => {
    const tags: (string | null)[] = [];
    const scores = decodeScores('[0.82, 0.12]', 2, tags);
    expect(scores).toHaveLength(2);
    expect(tags).toEqual([null, null]);
  });

  it('never returns a tag array shorter or longer than the scores', () => {
    for (const [output, n] of [
      ['[{"k":"home","s":0.82}]', 3],
      ['[{"k":"home","s":0.82},{"k":"none","s":0.1},{"k":"none","s":0.1},{"k":"none","s":0.1}]', 2],
      ['not json at all', 4],
    ] as const) {
      const tags: (string | null)[] = [];
      const scores = decodeScores(output, n, tags);
      expect(tags).toHaveLength(scores.length);
      expect(tags).toHaveLength(n);
    }
  });

  it('is byte-neutral when no out-array is passed', () => {
    // Every existing call site omits it, so the scores must be exactly what
    // they were before the tags were surfaced.
    expect(decodeScores('[{"k":"home","s":0.82},{"k":"none","s":0.12}]', 2)).toEqual([0.82, 0.12]);
  });
});
