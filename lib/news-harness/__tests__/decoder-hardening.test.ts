// The score decoder must never invent scores out of a model's prose.
//
// THE BUG THIS EXISTS FOR, measured live against z-ai/glm-5.3-flash on
// 2026-09-16. GLM leaks its reasoning into `content` as `trace</think>answer`.
// `JSON.parse` fails on the leading prose, and the old regex fallback then took
// the FIRST five numbers found anywhere in the text — which came from the
// reasoning trace ("Article 0", "I'll go 0.60-0.63", "Let's say 0.62"), not
// from the answer. On a call whose real answer was
//
//   [{"k":"domain","s":0.56},{"k":"interest","s":0.28}, …]
//
// the decoder returned 1.00 0.00 0.75 0.55 0.60. A 1.00 is an EMERGENCY-tier
// score invented from the model's scratch work, and nothing anywhere recorded a
// failure. Silent wrong data, which is worse than a crash.
//
// The fixtures are REAL captured outputs, not hand-written approximations, for
// a specific reason: the failure is about the exact shape of a leaked trace —
// stray decimals in prose, whether the `</think>` closer survived, where the
// array sits, and the fact that GLM emits the array TWICE (once inside the
// trace and again after the closer). A fixture someone typed would encode what
// we BELIEVE that shape is, and "what we believe the shape is" is precisely
// what was already wrong in two file headers in this repo.
import {
  parseBatchRelevanceResponse,
  parseReasonResponse,
  newRelevanceDecodeStats,
} from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import FIXTURE from './fixtures/glm-leaked-scoring.json';
import REASON_FIXTURE from './fixtures/glm-leaked-reason.json';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const FALLBACK = CFG.fallbackRelevance;

const decode = (out: string, n: number, stats?: ReturnType<typeof newRelevanceDecodeStats>) =>
  parseBatchRelevanceResponse(out, n, 'id', undefined, CFG, undefined, stats);

describe('real GLM output — the complete answer decodes correctly', () => {
  const { output } = FIXTURE.complete;

  it('the fixture really is the shape we think it is', () => {
    // Non-vacuity: if the capture ever degrades into something without a trace,
    // every assertion below would pass for the wrong reason.
    expect(FIXTURE.complete.finishReason).toBe('stop');
    expect(FIXTURE.complete.hasThinkCloser).toBe(true);
    expect(output).toContain('</think>');
    expect(output.length).toBeGreaterThan(2000);
  });

  it('returns the five values the model actually emitted', () => {
    // The trailing array after </think>, which is the model's real answer.
    expect(decode(output, 5)).toEqual([0.56, 0.28, 0.26, 0.29, 0.72]);
  });

  it('does not return the numbers that appear earlier in the prose', () => {
    // The precise regression: these are what the old regex path produced.
    expect(decode(output, 5)).not.toEqual([1.0, 0.0, 0.75, 0.55, 0.6]);
  });

  it('counts the entries as tiered, not as a regex fallback', () => {
    const stats = newRelevanceDecodeStats();
    decode(output, 5, stats);
    expect(stats.tieredEntries).toBe(5);
    expect(stats.regexFallbacks).toBe(0);
    expect(stats.totalFailures).toBe(0);
  });

  it('picks the LAST array when the model emits one inside the trace too', () => {
    // GLM writes the array once while reasoning and again as its answer. Taking
    // the first would read the draft rather than the conclusion. Here both
    // happen to agree, so assert the mechanism directly instead.
    const draftThenFinal =
      'thinking [{"k":"none","s":0.10},{"k":"none","s":0.10}] ' +
      'wait, no.</think>[{"k":"home","s":0.90},{"k":"domain","s":0.60}]';
    expect(decode(draftThenFinal, 2)).toEqual([0.9, 0.6]);
  });
});

describe('real GLM output — the truncated answer fails CLEANLY', () => {
  const { output } = FIXTURE.truncated;

  it('the fixture really is a truncated trace with no array at all', () => {
    expect(FIXTURE.truncated.finishReason).toBe('length');
    expect(FIXTURE.truncated.hasThinkCloser).toBe(false);
    expect(output).not.toContain('[');
  });

  it('returns the fallback for every article rather than scraped numbers', () => {
    // The old behaviour returned 1.00 0.00 0.75 0.60 0.00 here. An article
    // scored at the fallback sits below the 0.4 render gate, so a clean failure
    // means the row quietly does not show — which is the correct outcome for a
    // call that produced no answer.
    expect(decode(output, 5)).toEqual([FALLBACK, FALLBACK, FALLBACK, FALLBACK, FALLBACK]);
  });

  it('records the failure instead of reporting a successful decode', () => {
    const stats = newRelevanceDecodeStats();
    decode(output, 5, stats);
    expect(stats.totalFailures).toBe(1);
    expect(stats.tieredEntries).toBe(0);
    // The whole point: this call must be visible in the run summary. Under the
    // old decoder it showed as regex-fallbacks with zero failures.
    expect(stats.entries).toBe(0);
  });
});

describe('prose never becomes a score', () => {
  const CASES: [string, string][] = [
    ['a bare reasoning trace', 'Let me think. Article 0 is about 0.62 maybe. Article 1 around 0.30.'],
    ['a refusal', 'I cannot help with that.'],
    ['an apology with numbers', 'Sorry, I could not score 5 articles in 1 pass.'],
    ['a chatty preamble', 'here you go: 0.61, 0.22'],
    ['a truncated think block', '<think>0.9 0.8 0.7 0.6 0.5 and then'],
  ];

  it.each(CASES)('%s decodes to the fallback, not to numbers', (_name, text) => {
    const stats = newRelevanceDecodeStats();
    const out = decode(text, 2, stats);
    expect(out).toEqual([FALLBACK, FALLBACK]);
    expect(stats.totalFailures).toBe(1);
  });

  it('NOTE: the chatty-preamble case is a deliberate behaviour change', () => {
    // "here you go: 0.61, 0.22" used to decode to [0.61, 0.22] and there was a
    // test asserting it. It no longer does, and that test was updated on
    // purpose. Losing that rescue is the price of the rule, and the trade is
    // one-sided: a chatty model that still answers is rare and costs us a
    // fallback score, while a thinking model's trace is common and cost us an
    // invented 1.00. Prefer the failure we can see.
    expect(decode('here you go: 0.61, 0.22', 2)).toEqual([FALLBACK, FALLBACK]);
  });
});

describe('what must keep working', () => {
  it('a clean tiered array', () => {
    expect(decode('[{"k":"domain","s":0.62},{"k":"none","s":0.12}]', 2)).toEqual([0.62, 0.12]);
  });

  it('a clean legacy number array', () => {
    expect(decode('[0.5, 0.9]', 2)).toEqual([0.5, 0.9]);
  });

  it('an array with surrounding whitespace or a newline', () => {
    expect(decode('\n  [0.5, 0.9]\n', 2)).toEqual([0.5, 0.9]);
  });

  it('an array wrapped in a markdown code fence', () => {
    // Common and harmless: the array is still the last balanced array present.
    expect(decode('```json\n[{"k":"home","s":0.90}]\n```', 1)).toEqual([0.9]);
  });

  it('still band-clamps a self-contradicting entry', () => {
    const stats = newRelevanceDecodeStats();
    expect(decode('[{"k":"none","s":0.71}]', 1, stats)).toEqual([0.24]);
    expect(stats.bandViolations).toBe(1);
  });

  it('still pads a short array to expectedCount', () => {
    const stats = newRelevanceDecodeStats();
    const out = decode('[{"k":"none","s":0.10}]', 3, stats);
    expect(out).toHaveLength(3);
    expect(stats.lengthMismatches).toBe(1);
  });

  it('a bare numbers list with no prose at all still decodes', () => {
    // No letters anywhere, so there is no trace to mistake it for. This is the
    // one narrow case the regex path is still allowed to serve.
    expect(decode('0.61, 0.22', 2)).toEqual([0.61, 0.22]);
  });
});

// ---------------------------------------------------------------------------
// The reason string is the user-facing half, and it failed worse.
// ---------------------------------------------------------------------------
describe('the reason decoder never shows the model its own scratch work', () => {
  const truncated = REASON_FIXTURE.truncated.output;
  const complete = REASON_FIXTURE.complete.output;

  it('the fixtures really are the shapes we think they are', () => {
    expect(REASON_FIXTURE.truncated.finishReason).toBe('length');
    expect(REASON_FIXTURE.truncated.hasThinkCloser).toBe(false);
    expect(truncated).toMatch(/^Let me analyze/);
    expect(REASON_FIXTURE.complete.hasThinkCloser).toBe(true);
  });

  it('rejects a truncated trace outright rather than rendering it', () => {
    // What the old decoder returned here, and what a reader would have seen on
    // the feed card under "why this matters to you":
    //   "Let me analyze this article. Article: "After hacker attack, EU
    //    discusses AI laws with Anthropic and OpenAI", EU discussing AI legisl"
    // An empty string means reason_pending, and the card simply shows no note.
    expect(parseReasonResponse(truncated, 'id')).toBe('');
  });

  it('the dash rule alone would NOT have saved it', () => {
    // The trace contains an em dash, so the copy contract would tidy it into a
    // comma and ship the trace looking that bit more like real prose. This is
    // why the copy fix and this one are different fixes.
    expect(truncated).toMatch(/[\u2014\u2013\u2015]/);
  });

  it('returns the real sentence from a complete answer', () => {
    // GLM writes a good reason when it is allowed to finish: second person,
    // names the article detail and the linking fact, no em dash.
    expect(parseReasonResponse(complete, 'id')).toBe(
      'EU talks with Anthropic and OpenAI on AI laws may shape rules for the consumer apps you build in Amsterdam.',
    );
  });

  it('rejects an unclosed think tag', () => {
    expect(parseReasonResponse('<think>weighing this up', 'id')).toBe('');
  });

  it('rejects a first-person deliberation opener', () => {
    for (const opener of [
      'Let me analyze this article and see.',
      'Let me think about what matters here.',
      "Let's work through the article.",
      'First, I need to check the user facts.',
      "I'll start by reading the description.",
    ]) {
      expect(parseReasonResponse(opener, 'id')).toBe('');
    }
  });

  it('does not reject a legitimate reason that merely starts with a capital I', () => {
    // The opener rule must be narrow. These are real reason shapes.
    const ok = [
      'Indian rail strike affects the Bhopal route your parents use.',
      'Letting agents in Amsterdam face new rules, which touches your housing tracking.',
      'First-time buyer rules changed in the Netherlands, where you live.',
    ];
    for (const r of ok) expect(parseReasonResponse(r, 'id')).toBe(r);
  });

  it('keeps every pre-existing cleanup behaviour', () => {
    expect(parseReasonResponse('**Dutch tax vote** affects your work.', 'id')).toBe(
      'Dutch tax vote affects your work.',
    );
    expect(parseReasonResponse('"A plain quoted sentence."', 'id')).toBe(
      'A plain quoted sentence.',
    );
    expect(parseReasonResponse('{"reason":"From an object."}', 'id')).toBe('From an object.');
  });
});
