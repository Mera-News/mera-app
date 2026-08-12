// The guards that make the honesty contract structural, not a matter of prompt
// wording.
//
// WHAT THIS FILE STOPPED COVERING (pivot P8c). The two-tier on-device JOB is
// gone: the ClaimReview lookup moved to the server (it is the only thing that
// may attribute a rating to an organisation) and nothing here persists any more.
// The "we could not look" contract did not go with it — it moved DOWN a layer,
// to the quick path, and is tested at the seam that now produces user-visible
// text: see `lib/chat-tools/__tests__/quick-fact-check-handler.test.ts`, whose
// must-fail test drives an unavailable search and asserts it can never render as
// "found nothing".
//
// What remains here is what makes a fabricated source impossible rather than
// unlikely, and every one of these still guards the quick path:
//   • `clampVerdictToEvidence` — `supported` is unreachable with zero evidence;
//   • `resolveCitations` — an index the evidence cannot resolve is dropped;
//   • `coerceVerdict` — a negated verdict degrades rather than inverting;
//   • `buildSearchQueries` — the claim is never pasted verbatim.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// The module imports the transport for its query cap — stubbed so no suite ever
// opens a socket.
jest.mock('@/lib/web-search/web-search-client', () => ({
  __esModule: true,
  searchWeb: jest.fn(),
  MIN_QUERY_CHARS: 2,
  MAX_QUERY_CHARS: 200,
}));

import {
  buildSearchQueries,
  clampVerdictToEvidence,
  coerceVerdict,
  parseSynthesis,
  resolveCitations,
} from '../fact-check-runner';

const CLAIM = 'The vaccine schedule requires children to receive 80 different vaccines.';
const ARTICLE_TITLE = 'Trump repeats vaccine schedule claim';

const RESULTS = [
  { title: 'PolitiFact: no, children do not get 80 vaccines', url: 'https://politifact.com/a', snippet: 'The schedule lists 36 doses.' },
  { title: 'FactCheck.org on the vaccine schedule', url: 'https://factcheck.org/b', snippet: 'Claim overstates the count.' },
];

// ── The structural guards ──────────────────────────────────────────────────

describe('clampVerdictToEvidence', () => {
  it('makes `supported` unreachable with an empty evidence set', () => {
    expect(clampVerdictToEvidence('supported', 0)).toBe('unverifiable');
    expect(clampVerdictToEvidence('disputed', 0)).toBe('unverifiable');
  });
  it('leaves a verdict alone once there is evidence', () => {
    expect(clampVerdictToEvidence('supported', 1)).toBe('supported');
  });
});

describe('resolveCitations', () => {
  it('drops indices the evidence cannot resolve — a model cannot invent a source', () => {
    const out = resolveCitations([1, 99, -3], RESULTS);
    expect(out.map((c) => c.uri)).toEqual(['https://politifact.com/a']);
  });
  it('uses `uri`, not `url` — the render layer reads `uri`', () => {
    expect(Object.keys(resolveCitations([1], RESULTS)[0])).toContain('uri');
  });
  it('falls back to the gathered evidence when the model cites nothing', () => {
    expect(resolveCitations([], RESULTS)).toHaveLength(2);
  });
});

describe('coerceVerdict — the negation guard, reproduced from the server', () => {
  it('takes a bare verdict word out of a justified answer', () => {
    expect(coerceVerdict('mixed — two of four claims hold')).toBe('mixed');
  });
  it('refuses to print the opposite of what the answer said', () => {
    expect(coerceVerdict('not supported by any source')).toBe('unverifiable');
    expect(coerceVerdict('no claims are disputed')).toBe('unverifiable');
  });
  it('does not over-fire on a negation AFTER the verdict', () => {
    expect(coerceVerdict('mixed - two claims are not corroborated')).toBe('mixed');
  });
  it('falls to unverifiable on anything unrecognised or absent', () => {
    expect(coerceVerdict('probably fine')).toBe('unverifiable');
    expect(coerceVerdict(null)).toBe('unverifiable');
  });
});

describe('parseSynthesis', () => {
  it('reads the JSON contract', () => {
    const p = parseSynthesis(
      'Here you go:\n{"verdict":"disputed","summary":"S","claims":[{"claim":"C","assessment":"unsupported"}],"citations":[1,2]}',
      2,
    );
    expect(p.verdict).toBe('disputed');
    expect(p.summary).toBe('S');
    expect(p.claims).toEqual([{ claim: 'C', assessment: 'unsupported', note: undefined }]);
    expect(p.citationIndices).toEqual([1, 2]);
  });
  it('degrades an unparseable answer to unverifiable, never to a confident one', () => {
    expect(parseSynthesis('I think this is broadly supported, probably', 3).verdict).toBe('supported');
    expect(parseSynthesis('no idea', 3).verdict).toBe('unverifiable');
  });
  it('discards citation indices outside the evidence list', () => {
    expect(parseSynthesis('{"verdict":"mixed","citations":[1,7,"3"]}', 3).citationIndices).toEqual([1, 3]);
  });
});

describe('buildSearchQueries', () => {
  const claim = CLAIM;
  it('never pastes the claim and never exceeds the gateway cap', () => {
    for (const q of buildSearchQueries(claim, ARTICLE_TITLE)) {
      expect(q.length).toBeLessThanOrEqual(200);
      expect(q).not.toBe(claim);
    }
  });
  it('produces at most three distinct rounds', () => {
    const qs = buildSearchQueries(claim, ARTICLE_TITLE);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(new Set(qs).size).toBe(qs.length);
  });
  it('drops stopwords but keeps the entities', () => {
    expect(buildSearchQueries('The vaccine schedule requires 80 doses')[0]).toBe('vaccine schedule requires 80 doses');
  });
  it('still produces a usable query for a non-Latin claim', () => {
    const qs = buildSearchQueries('मुख्यमंत्री ने कहा कि बजट दोगुना हुआ');
    expect(qs[0].length).toBeGreaterThan(1);
  });
  it('survives a very long claim by fitting to the cap at a word boundary', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const q = buildSearchQueries(long)[0];
    expect(q.length).toBeLessThanOrEqual(200);
    expect(q.endsWith(' ')).toBe(false);
  });
});
