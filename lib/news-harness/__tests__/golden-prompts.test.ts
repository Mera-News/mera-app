// Golden test: the old-path shim (lib/mera-protocol/scoring-service) and the
// harness must build byte-identical score/reason BatchCalls. Prompts are NOT
// mocked (real); only the shim's RN dependencies (LLM, DB, store, logger) are.
//
// "Byte-identical" now means identical MODULO the per-build article-fence
// nonce, which is random by design and therefore differs between any two
// independent builds. See `stripNonce` below, and the fence-shape assertions at
// the end of the file which pin what the normalisation deliberately hides.

jest.mock('@/lib/llm/completeLocal', () => ({ completeLocal: jest.fn() }));
jest.mock('@/lib/database/services/calibration-service', () => ({
  recordOverrides: jest.fn().mockResolvedValue({ count: 0, notified: false }),
  getScoringOverrides: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudComplete: jest.fn(),
  cloudBatchComplete: jest.fn(),
}));
jest.mock('@/lib/llm/constants', () => ({ SMALL_MODEL: 'test-small-model' }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
  },
}));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
  countUnscoredSuggestions: jest.fn(),
  getScoredSuggestionsWithoutReasons: jest.fn(),
  getUnscoredSuggestionsWithFacts: jest.fn(),
  saveReason: jest.fn(),
  saveScoringResult: jest.fn(),
}));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: jest.fn() }));
// scoring-service now imports stage-scoring, which pulls in the persona DB
// services at load time; mock it so scoring-service loads without native deps.
jest.mock('@/lib/mera-protocol/stage-scoring', () => ({
  computeAndScoreForCandidates: jest.fn(),
  computeMathStage: jest.fn(),
  loadPersonaScoringContext: jest.fn(),
  buildStageCandidates: jest.fn(),
  getScoringLlmPort: jest.fn(),
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: { getState: jest.fn(() => ({ processingMode: 'CLOUD' })) },
}));
jest.mock('@/lib/generated/graphql-types', () => ({
  ProcessingMode: { Cloud: 'CLOUD', OnDevice: 'ON_DEVICE' },
}));

import {
  buildRelevanceCalls as shimBuildRelevanceCalls,
  buildReasonCallsForSubset as shimBuildReasonCallsForSubset,
} from '@/lib/mera-protocol/scoring-service';
import {
  buildRelevanceCalls as harnessBuildRelevanceCalls,
  buildReasonCallsForSubset as harnessBuildReasonCallsForSubset,
  buildScoreCallForChunk,
} from '../article-pipeline/scoring';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  CLOUD_V3_NOTE_SYSTEM_PROMPT,
  CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  LOCAL_RELEVANCE_SYSTEM_PROMPT,
  LOCAL_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO,
  RULE_NAME_BAN,
} from '../prompts/prompts';
import { estimateTokens } from '@/lib/llm/tokens';
// The REAL encrypt path, so the wire-size formula below is proved, not assumed.
// `e2ee-crypto` is the Node-importable half of the E2EE module on purpose.
import { ed25519 } from '@noble/curves/ed25519.js';
import { encryptContent, bytesToHex } from '@/lib/e2ee/e2ee-crypto';
import { getFacts } from '@/lib/database/services/fact-service';
import type { ScoringCandidate } from '../core/types';

const mockGetFacts = getFacts as jest.MockedFunction<typeof getFacts>;

const FACT_STATEMENTS = ['Lives in Amsterdam, Netherlands', 'Works in AI'];

// Article content is fenced with a per-build random nonce, so two independent
// builds of the same prompt differ in exactly that token and nowhere else. The
// guarantee this file exists to pin is shim/harness STRUCTURAL identity, not
// equality of a random value, so both sides are normalised before comparison
// and the fence itself is asserted separately below.
//
// The shim (lib/mera-protocol/scoring-service) does not thread a nonce through,
// so pinning the value instead of normalising it is not available here.
const NONCE = /[a-f0-9]{12}/g;
const stripNonce = (s: string) => s.replace(NONCE, 'NONCE');
const stripNonces = (xs: string[]) => xs.map(stripNonce);

function candidate(id: string): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description for ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: `related fact ${id}` }],
  };
}

/**
 * A candidate carrying a PUBLISHER and a non-English language, which the plain
 * `candidate()` above does not.
 *
 * Its absence is how a real gap hid: the shim builds its own article block, and
 * when `publicationName` was threaded into the harness but not the shim, this
 * file still passed because BOTH sides omitted a line neither fixture asked
 * for. A parity test whose fixture lacks the field cannot detect divergence in
 * that field.
 *
 * It also pins the alpha-3 path on a second code. The stored codes are alpha-3
 * (`NLD`, `PRT`, `ESP`), and `resolveCountryName` resolves them via the alias
 * table, so "PRT" must reach the prompt as "Portugal" on BOTH sides. That
 * matters beyond parity: an article whose country line goes missing is scored
 * with no geographic signal at all.
 */
function publisherCandidate(id: string): ScoringCandidate {
  return {
    ...candidate(id),
    countryCode: 'PRT',
    publicationName: 'Diário de Notícias',
    languageCode: 'pt',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue(
    FACT_STATEMENTS.map((statement) => ({ statement })) as never,
  );
});

describe('golden — buildRelevanceCalls', () => {
  it('shim and harness produce byte-identical score calls (incl. chunking)', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map(candidate); // 6 → 2 chunks
    const shim = await shimBuildRelevanceCalls(candidates);
    const harness = harnessBuildRelevanceCalls(candidates, FACT_STATEMENTS);

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(stripNonces(shim.calls.map((c) => c.prompt))).toEqual(
      stripNonces(harness.calls.map((c) => c.prompt)),
    );
    expect(shim.calls.map((c) => c.temperature)).toEqual(
      harness.calls.map((c) => c.temperature),
    );
    expect(shim.calls.map((c) => c.maxTokens)).toEqual(
      harness.calls.map((c) => c.maxTokens),
    );
  });
});

describe('golden — buildReasonCallsForSubset', () => {
  it('shim and harness produce byte-identical reason calls', async () => {
    const candidates = [candidate('a'), candidate('b')];
    const relevanceMap = { a: 0.8, b: 0.92 };
    const shim = await shimBuildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    const harness = harnessBuildReasonCallsForSubset(
      candidates,
      relevanceMap,
      0.3,
      FACT_STATEMENTS,
    );

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(stripNonces(shim.calls.map((c) => c.prompt))).toEqual(
      stripNonces(harness.calls.map((c) => c.prompt)),
    );
  });
});

describe('harness buildScoreCallForChunk', () => {
  it('defaults the system prompt to CLOUD_RELEVANCE_SYSTEM_PROMPT', () => {
    const { system } = buildScoreCallForChunk([candidate('a')], FACT_STATEMENTS);
    expect(system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });
});

describe('golden — measured prompt sizes', () => {
  // These four numbers are the INPUTS to the batch-size arithmetic in
  // core/config.ts (headlineArticlesPerScorePrompt = 5 × 4454/7105 → 3). They
  // are pinned here so editing a prompt fails loudly instead of silently
  // invalidating that derivation — re-measure, redo the arithmetic, then update
  // both the comment and these pins together.
  //
  // The first two ALSO guard the CLOUD_REASON_VOICE_RULE extraction (P4a): the
  // voice paragraph was lifted out of CLOUD_REASON_SYSTEM_PROMPT into a shared
  // const so the headline reason prompt cannot carry a retyped copy. Nothing
  // else pins that prompt's content — config.test.ts and the shim comparisons
  // above are all identity checks against the same const, so a whitespace slip
  // during the extraction would have passed every existing test.
  it('pins the estimated token size of each cloud scoring prompt', () => {
    // RE-PINNED when the article-scope rule was promoted into the shared base:
    // one section in ONE const, so every prompt built on it moved by the same
    // +130 tokens, and the derivation below is intact:
    //   5 * (4584 / 7234) = 3.1685 -> 3   (was 5 * (4454 / 7105) = 3.1344 -> 3)
    // `headlineArticlesPerScorePrompt` therefore stays 3 and no
    // DEFAULT_HARNESS_CONFIG literal changed. Only the two RELEVANCE numbers
    // feed that arithmetic.
    //
    // RE-PINNED AGAIN when the headline reason prompt dropped the anchor table
    // to fit the gateway wire cap: 8256 -> 6958, a 1298-token cut that no other
    // prompt takes. See the wire-cap block below for why.
    expect(estimateTokens(CLOUD_RELEVANCE_SYSTEM_PROMPT)).toBe(4584);
    expect(estimateTokens(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBe(7234);
    // ux1: +43 for RULE_NAME_BAN, which names the rubric label in every spelling.
    expect(estimateTokens(CLOUD_REASON_SYSTEM_PROMPT)).toBe(5511);
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBe(7066);
  });

  // The four above were the only pinned prompts. These four were not pinned by
  // anything, and two of them are reachable from a single shared edit:
  //
  //   - CLOUD_V3_NOTE_SYSTEM_PROMPT and CLOUD_HEADLINE_REASON_SYSTEM_PROMPT both
  //     embed CLOUD_REASON_VOICE_RULE, so a one-line change to that shared const
  //     moves THREE prompts and only one of them used to notice.
  //   - CLOUD_V3_NOTE_SYSTEM_PROMPT is built ON CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  //     so a verifier edit moves it transitively. Pinning the note alone would
  //     say it moved without saying why; pinning both separates the two causes.
  //   - The LOCAL pair is pinned because the on-device family is deliberately
  //     OUT OF SCOPE for prompt experiments and nothing exercises it —
  //     eval:golden scores relevance and never runs a reason prompt at all. An
  //     unmeasured path with no pin is one where a change ships invisibly.
  it('pins the estimated token size of the prompts nothing else guards', () => {
    expect(estimateTokens(CLOUD_V3_NOTE_SYSTEM_PROMPT)).toBe(1903);
    expect(estimateTokens(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT)).toBe(1539);
    expect(estimateTokens(LOCAL_RELEVANCE_SYSTEM_PROMPT)).toBe(1104);
    expect(estimateTokens(LOCAL_REASON_SYSTEM_PROMPT)).toBe(1558);
  });

  // THE GATEWAY WIRE CAP. A PROD 400 lives behind these numbers.
  //
  // Every call in a bundle carries the same system string, so
  // `submitInferenceJob` hoists it into the job's `sharedSystem` and encrypts it
  // ONCE (`lib/services/scoring-pipeline.ts` is the caller, through
  // `sendInferenceRequest`). The gateway's DTO rejects that field over
  // MAX_SHARED_SYSTEM_BYTES = 65536. On 2026-09-17 prod returned
  //   400 "sharedSystem must be shorter than or equal to 65536 characters"
  // on a live scoring job, because CLOUD_HEADLINE_REASON_SYSTEM_PROMPT was
  // 66982 on the wire. It had been over the cap by 408 BEFORE the article-scope
  // rule was promoted, so reverting a prompt rule would not have fixed it: the
  // headline reason prompt now drops the anchor table, which is pass-1
  // calibration and dead weight in a pass that is handed its score.
  //
  // BYTES, NOT CHARACTERS. These prompts are full of em dashes and arrows, so
  // the utf8 length runs about 1.2% above `.length` — 400 bytes on the headline
  // prompts, which is the difference between passing and not.
  const CAP = 65536;
  const wire = (p: string) => 2 * (Buffer.byteLength(p, 'utf8') + 72);

  // Only prompts that are actually SENT. The `_V1` and `_PRE_GEO` composites
  // are archives of what shipped and must never be "fixed" to fit; see the
  // over-cap assertion below, which pins that they are over and arm-only.
  const SHIPPED_SYSTEM_PROMPTS: [string, string][] = [
    ['CLOUD_RELEVANCE_SYSTEM_PROMPT', CLOUD_RELEVANCE_SYSTEM_PROMPT],
    ['CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT', CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT],
    ['CLOUD_REASON_SYSTEM_PROMPT', CLOUD_REASON_SYSTEM_PROMPT],
    ['CLOUD_HEADLINE_REASON_SYSTEM_PROMPT', CLOUD_HEADLINE_REASON_SYSTEM_PROMPT],
    ['CLOUD_FEED_VERIFIER_SYSTEM_PROMPT', CLOUD_FEED_VERIFIER_SYSTEM_PROMPT],
    ['CLOUD_V3_NOTE_SYSTEM_PROMPT', CLOUD_V3_NOTE_SYSTEM_PROMPT],
    ['LOCAL_RELEVANCE_SYSTEM_PROMPT', LOCAL_RELEVANCE_SYSTEM_PROMPT],
    ['LOCAL_REASON_SYSTEM_PROMPT', LOCAL_REASON_SYSTEM_PROMPT],
  ];

  it('proves the wire formula against the REAL encryptContent, not a guess', () => {
    // 32 B ephemeral pubkey + 24 B nonce + ciphertext + 16 B poly1305 tag, hex.
    // Asserted rather than assumed, because every number below is computed from
    // this formula and a wrong constant would make the whole guard decorative.
    const sk = ed25519.utils.randomSecretKey();
    const ctx = {
      modelPubKeyHex: bytesToHex(ed25519.getPublicKey(sk)),
      privateKey: sk,
      clientPubKeyHex: '',
      algo: 'ed25519' as const,
      headers: {} as never,
    };
    for (const [, p] of SHIPPED_SYSTEM_PROMPTS) {
      expect(encryptContent(p, ctx).length).toBe(wire(p));
    }
  });

  it.each(SHIPPED_SYSTEM_PROMPTS)(
    '%s fits the gateway cap with at least 10%% to spare',
    (_name, prompt) => {
      // 0.9 * CAP, not CAP. A prompt sitting at 99% of the limit is one edit
      // from a prod 400, and the edit that breaks it is usually in the SHARED
      // base, so its author is not looking at this prompt at all.
      expect(wire(prompt)).toBeLessThanOrEqual(0.9 * CAP);
    },
  );

  it('pins the wire size of every shipped system prompt', () => {
    // The tripwire. A number moving here means a prompt grew; check it against
    // the cap above before re-pinning.
    expect(SHIPPED_SYSTEM_PROMPTS.map(([n, p]) => `${n} ${wire(p)}`)).toEqual([
      'CLOUD_RELEVANCE_SYSTEM_PROMPT 37322',
      'CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT 58816',
      'CLOUD_REASON_SYSTEM_PROMPT 44768',
      'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT 57260',
      'CLOUD_FEED_VERIFIER_SYSTEM_PROMPT 12528',
      'CLOUD_V3_NOTE_SYSTEM_PROMPT 15460',
      'LOCAL_RELEVANCE_SYSTEM_PROMPT 9106',
      'LOCAL_REASON_SYSTEM_PROMPT 12788',
    ]);
  });

  it('records that the pre-geo headline reason ARCHIVE is over the cap', () => {
    // Deliberate, and the reason `pre-geo-control` must never be run on a
    // headline bundle: this string is the byte-exact record of what shipped,
    // and what shipped was already 408 over. Fixing it would destroy the
    // archive; the arm's description carries the warning.
    expect(wire(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO)).toBe(65944);
    expect(wire(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO)).toBeGreaterThan(CAP);
  });

  it('keeps the headline reason prompt as the ONLY shipped one without anchors', () => {
    // The cut is surgical on purpose. Anything that CHOOSES a score keeps its
    // 47 calibration examples; only the pass that is handed one loses them.
    expect(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT).not.toContain('## Anchors (example user');
    for (const [name, p] of SHIPPED_SYSTEM_PROMPTS) {
      if (name === 'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT') continue;
      if (!name.startsWith('CLOUD_') || name.includes('VERIFIER') || name.includes('V3_NOTE')) continue;
      expect(p).toContain('## Anchors (example user');
    }
    // What replaces it for pass 2: the score-to-tone table and the impact
    // block's own worked examples, both still present.
    expect(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT).toContain('### Worked examples');
    expect(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT).toContain('## Priority');
    expect(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT).toContain('## Article scope');
  });

  it('keeps the V3 note prompt built ON the verifier rather than restating it', () => {
    // The note prompt's own header says it "REUSES CLOUD_FEED_VERIFIER_SYSTEM_PROMPT
    // verbatim rather than restating its rules", because those NO-patterns were
    // validated against the golden 1000-article run and a second copy would
    // drift from them. This is that claim, asserted.
    expect(CLOUD_V3_NOTE_SYSTEM_PROMPT.startsWith(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT)).toBe(
      true,
    );
    expect(estimateTokens(CLOUD_V3_NOTE_SYSTEM_PROMPT)).toBeGreaterThan(
      estimateTokens(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT),
    );
  });

  it('keeps every LOCAL prompt smaller than its CLOUD counterpart', () => {
    // The on-device model loses calibration on a prompt the cloud model holds
    // fine, which is why the two families exist at all. A local prompt that grew
    // past its cloud twin has lost the only reason it is a separate string.
    expect(estimateTokens(LOCAL_RELEVANCE_SYSTEM_PROMPT)).toBeLessThan(
      estimateTokens(CLOUD_RELEVANCE_SYSTEM_PROMPT),
    );
    expect(estimateTokens(LOCAL_REASON_SYSTEM_PROMPT)).toBeLessThan(
      estimateTokens(CLOUD_REASON_SYSTEM_PROMPT),
    );
  });

  it('keeps the headline variants strictly additive over the live prompts', () => {
    // Same base + the same shared voice rule ⇒ the headline prompt is always
    // longer than its live counterpart. If this ever inverts, something was
    // REPLACED rather than added and the tier/voice guarantees are gone.
    expect(estimateTokens(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBeGreaterThan(
      estimateTokens(CLOUD_RELEVANCE_SYSTEM_PROMPT),
    );
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBeGreaterThan(
      estimateTokens(CLOUD_REASON_SYSTEM_PROMPT),
    );
  });
});

// ---------------------------------------------------------------------------
// P4b — the SHIM is the live path (lib/services/scoring-pipeline imports its
// builders from lib/mera-protocol/scoring-service, not from the harness). The
// blocks above only ever build standard candidates, so they would stay green
// with the headline routing wired in the harness and missing from the shim —
// exactly how this feature would ship inert. These pin shim/harness identity on
// the HEADLINE path too.
// ---------------------------------------------------------------------------

function headlineCandidate(id: string): ScoringCandidate {
  return {
    ...candidate(id),
    meta: {
      id,
      titleEn: `Title ${id}`,
      descriptionEn: `Description for ${id}`,
      publicationName: null,
      countryCode: null,
      firstPubDateMs: null,
      maxClusterSize: null,
      eventType: null,
      category: null,
      geoTagsJson: null,
      entitiesJson: null,
      matchedTopicsJson: null,
      headlineScope: 'GLOBAL',
      stableClusterId: null,
    },
  };
}

describe('golden — headline variant (P4b routing)', () => {
  it('shim and harness produce byte-identical HEADLINE score calls (incl. chunking at 3)', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(headlineCandidate);
    const shim = await shimBuildRelevanceCalls(candidates);
    const harness = harnessBuildRelevanceCalls(candidates, FACT_STATEMENTS);

    // 7 headline candidates at 3 per call = 3 calls (not 2, as 5-chunking gives).
    expect(shim.calls).toHaveLength(3);
    expect(shim.scoreChunkSize).toBe(3);
    expect(harness.scoreChunkSize).toBe(3);
    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    expect(stripNonces(shim.calls.map((c) => c.prompt))).toEqual(
      stripNonces(harness.calls.map((c) => c.prompt)),
    );
    expect(shim.calls.every((c) => c.system === CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT)).toBe(
      true,
    );
  });

  it('the SHIM routes headline candidates to the headline relevance prompt', async () => {
    const shim = await shimBuildRelevanceCalls([headlineCandidate('a')]);
    expect(shim.calls[0].system).toBe(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT);
  });

  it('the SHIM keeps standard candidates on the standard prompt at chunk 5', async () => {
    const shim = await shimBuildRelevanceCalls(['a', 'b', 'c', 'd', 'e', 'f'].map(candidate));
    expect(shim.scoreChunkSize).toBe(5);
    expect(shim.calls).toHaveLength(2);
    expect(shim.calls[0].system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });

  it('shim and harness select the headline REASON prompt per candidate, identically', async () => {
    const candidates = [headlineCandidate('h'), candidate('s')];
    const relevanceMap = { h: 0.72, s: 0.65 };
    const shim = await shimBuildReasonCallsForSubset(candidates, relevanceMap, 0.3);
    const harness = harnessBuildReasonCallsForSubset(
      candidates,
      relevanceMap,
      0.3,
      FACT_STATEMENTS,
    );

    expect(shim.calls.map((c) => c.id)).toEqual(harness.calls.map((c) => c.id));
    expect(shim.calls.map((c) => c.system)).toEqual(harness.calls.map((c) => c.system));
    const systemById = new Map(shim.calls.map((c) => [c.id, c.system] as const));
    expect(systemById.get('reason:h')).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
    expect(systemById.get('reason:s')).toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// The article fence. `stripNonce` above deliberately hides the nonce VALUE from
// the identity comparisons, so these assertions pin everything about the fence
// that normalisation would otherwise let through: that it is there at all, that
// both sides agree on its shape, and that one prompt build uses ONE nonce.
// ---------------------------------------------------------------------------

describe('golden — article fence', () => {
  it('fences every article block in both the shim and the harness build', async () => {
    const candidates = [candidate('a'), candidate('b')];
    const shim = await shimBuildRelevanceCalls(candidates);
    const harness = harnessBuildRelevanceCalls(candidates, FACT_STATEMENTS);

    for (const prompt of [shim.calls[0].prompt, harness.calls[0].prompt]) {
      const opens = prompt.match(/<<ARTICLE [a-f0-9]{12}>>/g) ?? [];
      const closes = prompt.match(/<<\/ARTICLE [a-f0-9]{12}>>/g) ?? [];
      expect(opens).toHaveLength(2);
      expect(closes).toHaveLength(2);
      // One nonce per prompt build, not one per article.
      expect(new Set([...opens, ...closes].map((m) => m.match(/[a-f0-9]{12}/)![0])).size).toBe(1);
    }
  });

  it('gives two independent builds different nonces', async () => {
    const first = await shimBuildRelevanceCalls([candidate('a')]);
    const second = await shimBuildRelevanceCalls([candidate('a')]);
    const nonceOf = (s: string) => s.match(/<<ARTICLE ([a-f0-9]{12})>>/)![1];

    expect(nonceOf(first.calls[0].prompt)).not.toBe(nonceOf(second.calls[0].prompt));
    // ...and the two are otherwise the same prompt, which is what makes the
    // normalisation in the identity tests above safe rather than permissive.
    expect(stripNonce(first.calls[0].prompt)).toBe(stripNonce(second.calls[0].prompt));
  });
});

// ---------------------------------------------------------------------------
// Publisher + alpha-3 parity. See `publisherCandidate` for why the plain
// fixture could not have caught the divergence this section pins.
// ---------------------------------------------------------------------------
describe('golden — publisher and alpha-3 country parity', () => {
  it('shim and harness agree on a candidate carrying a publisher', async () => {
    const cands = [publisherCandidate('p1'), publisherCandidate('p2')];
    const shim = await shimBuildRelevanceCalls(cands);
    const harness = harnessBuildRelevanceCalls(cands, FACT_STATEMENTS);
    expect(stripNonces(harness.calls.map((c) => c.prompt))).toEqual(
      stripNonces(shim.calls.map((c) => c.prompt)),
    );
  });

  it('the SHIPPED path renders alpha-3 PRT as "Portugal"', async () => {
    // This is the assertion that answers "did the model even see a country?".
    // A missing or raw-code country line is the difference between scoring the
    // article at 0.20 and scoring it 0.85 on a strong fact match.
    const shim = await shimBuildRelevanceCalls([publisherCandidate('p1')]);
    expect(shim.calls[0].prompt).toMatch(/Article Country: Portugal/);
  });

  it('the SHIPPED path carries the publisher and its language', async () => {
    const shim = await shimBuildRelevanceCalls([publisherCandidate('p1')]);
    expect(shim.calls[0].prompt).toMatch(/Publication: Diário de Notícias \(Portuguese\)/);
  });

  it('shim and harness agree on the REASON prompt for such a candidate', async () => {
    const cands = [publisherCandidate('p1')];
    const rel = { p1: 0.62 };
    const shim = await shimBuildReasonCallsForSubset(cands, rel, 0.3);
    const harness = harnessBuildReasonCallsForSubset(cands, rel, 0.3, FACT_STATEMENTS);
    expect(stripNonces(harness.calls.map((c) => c.prompt))).toEqual(
      stripNonces(shim.calls.map((c) => c.prompt)),
    );
    expect(shim.calls[0].prompt).toMatch(/Publication: Diário de Notícias \(Portuguese\)/);
  });
});

// ux1: a device note read "...though it is a foreign-domestic case", the
// rubric's own label copied from a reason-prompt example into user copy.
describe('golden — reason prompts never teach the rubric labels as prose', () => {
  const REASON_PROMPTS: [string, string][] = [
    ['CLOUD_REASON_SYSTEM_PROMPT', CLOUD_REASON_SYSTEM_PROMPT],
    ['CLOUD_HEADLINE_REASON_SYSTEM_PROMPT', CLOUD_HEADLINE_REASON_SYSTEM_PROMPT],
    ['LOCAL_REASON_SYSTEM_PROMPT', LOCAL_REASON_SYSTEM_PROMPT],
  ];

  it.each(REASON_PROMPTS)('%s has no example sentence using "foreign-domestic"', (_n, p) => {
    // Every quoted example is a sentence the model may imitate verbatim.
    const quoted = p.match(/"[^"\n]{12,}"/g) ?? [];
    for (const q of quoted) {
      if (q.includes('foreign-domestic')) {
        // Allowed ONLY inside the ban list itself.
        expect(q.length).toBeLessThan(20);
      }
    }
  });

  it.each(REASON_PROMPTS)('%s tells the model not to name the rules', (_n, p) => {
    expect(p).toContain('Say what the rules found, never their names');
  });

  // K-3: once the hyphenated label alone was banned, a note read "...foreign
  // domestic policy...". The ban must name the category in every spelling.
  it.each(REASON_PROMPTS)('%s bans the label with AND without the hyphen', (_n, p) => {
    expect(p).toContain(RULE_NAME_BAN);
    expect(RULE_NAME_BAN).toContain('"foreign-domestic"');
    expect(RULE_NAME_BAN).toContain('"foreign domestic"');
  });

  it.each(REASON_PROMPTS)('%s has no example sentence using the label unhyphenated', (_n, p) => {
    const quoted = p.match(/"[^"\n]{20,}"/g) ?? [];
    for (const q of quoted) {
      expect(q.toLowerCase()).not.toMatch(/foreign[\s/]+domestic/);
    }
  });
});
