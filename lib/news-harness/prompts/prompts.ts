// Mera Protocol — article-pipeline system prompts.
//
// Relevance scoring, reason generation, their HEADLINE variants, the feed
// verifier, and the user-message builders that fence publisher text. The
// persona-update and topic-generation prompts live in ./persona-prompts and are
// re-exported below.
//
// Static system prompt (cacheable by KV cache) + dynamic context (injected into user messages).

import { asUntrusted, fenceArticleBlock, newPromptNonce } from './untrusted-text';
import { resolvePromptVariant, type PromptVariantId } from './prompt-variants';
import { CLOUD_BASE_SLOTS } from '../../harnesses/slots.generated';

// The boundary constructor and its brand are re-exported here so the many
// existing importers of `../prompts/prompts` keep one import site.
export {
  asUntrusted,
  sanitizeForPrompt,
  newPromptNonce,
  fenceArticleBlock,
  ARTICLE_FENCE_MARKER,
  DEFAULT_UNTRUSTED_MAX_LENGTH,
  type UntrustedText,
} from './untrusted-text';

// The persona-update and topic-generation prompts moved to ./persona-prompts
// (different owner, different edit cadence — one 1,956-line file made every
// edit a conflict). Re-exported here so no import site changed: every existing
// importer of `../prompts/prompts` still resolves the same symbols. New code
// may import either path.
export * from './persona-prompts';

// The prompt-variant seam. Re-exported here for the same reason as the
// untrusted-text boundary above: one import site for callers of this module.
export * from './prompt-variants';

/**
 * The second-person voice rule for every user-facing reason string.
 *
 * Extracted (byte-identical) out of CLOUD_REASON_SYSTEM_PROMPT so the headline
 * reason variant below shares the SAME text instead of a retyped copy. Nothing
 * pins this paragraph's content — config.test.ts compares prompt identity
 * (`toBe(CONST)`) and golden-prompts.test.ts compares shim-vs-harness (both
 * importing the same const) — so a retyped whitespace slip would drift silently
 * with every test green. One const, interpolated twice, removes that class of
 * drift. The same rule is separately pinned by string on the judge prompt
 * (config.test.ts "pins the second-person voice rule"), and QA 2026-07-28
 * showed what its absence costs: third-person reasons leaked to users.
 */
/**
 * Every reason prompt's ban on naming the scoring rules in the sentence a
 * reader sees. A rule name leaked twice: "foreign-domestic" copied from an
 * example, then "foreign domestic policy" once the hyphenated form alone was
 * banned. So the ban names the category in any spelling and says what to
 * write instead. Guarded by golden-prompts.test.ts.
 */
export const RULE_NAME_BAN = CLOUD_BASE_SLOTS["scoring/rule-name-ban"];

/**
 * Pass 1 — Relevance score only.
 * Returns a single number 0.0-1.1. No reason text, minimal output tokens.
 *
 * (Was marked DEPRECATE(v3) in favour of the single merged two-axis
 * score+reason call. That scorer is retired; this is the only pass-1 prompt.)
 */
export const CLOUD_RELEVANCE_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-relevance-system-prompt"];

/**
 * Pass 2 (cloud) — Reason generation for relevant articles (relevance > 0.3).
 * Generates a short user-facing "Why this matters to you" string.
 * Receives the relevance score in the user message — use the shared scale
 * above to calibrate tone and specificity.
 *
 * (Was marked DEPRECATE(v3) in favour of the merged call that emitted the reason
 * alongside the score. That scorer is retired; this is the only reason prompt —
 * see `legacyNoteDemote` for the variant that may also demote.)
 *
 * The reason prompt AS IT SHIPPED BEFORE reason-v2 was promoted. Exported only
 * so `prompts/reason-arms.ts` can register it as the `reason-v1` control arm:
 * a promotion with no way back to the thing it beat is not a measurement. Not
 * referenced by any production path.
 */
export const CLOUD_REASON_SYSTEM_PROMPT_V1 = CLOUD_BASE_SLOTS["scoring/cloud-reason-system-prompt-v1"];

export const CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-headline-relevance-system-prompt"];

/** See {@link CLOUD_REASON_SYSTEM_PROMPT_V1}: the headline twin, pre-promotion,
 *  kept for the same control arm. */
export const CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1 = CLOUD_BASE_SLOTS["scoring/cloud-headline-reason-system-prompt-v1"];

/**
 * Pass 2 (cloud) — the SHIPPED reason prompt.
 *
 * The task block plus {@link REASON_V2_RULES} in exactly the order the rater
 * scored, on the shipped base. Spelled out rather than built from `_V1`,
 * because `_V1` is frozen on the PRE-GEO base: reusing it here would have
 * silently kept the geography rule out of the reason pass while the score pass
 * gained it, which is the exact split the shared base exists to prevent.
 */
export const CLOUD_REASON_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-reason-system-prompt"];

/**
 * The headline twin of {@link CLOUD_REASON_SYSTEM_PROMPT}: same rules, same
 * order, on {@link CLOUD_SCORING_BASE_PROMPT_NO_ANCHORS}.
 *
 * The ONLY shipped prompt that drops the anchor table, and only because it is
 * the only one that does not fit under the gateway's wire cap with it. See that
 * const for the arithmetic and the prod 400 that forced it.
 */
export const CLOUD_HEADLINE_REASON_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-headline-reason-system-prompt"];

// ---------------------------------------------------------------------------
// ARM PROMPTS. Whole strings, each the shipped prompt with ONE thing changed,
// so a result is attributable to that one thing:
//
//   pre-geo-control  all four scoring prompts on the base as it stood BEFORE
//                    the article-scope rule was promoted. The way back to the
//                    text the rule beat, so the promotion stays falsifiable.
//   reason-rescore   pass 2 answers with an object and re-derives the score,
//                    on the current shipped base. MEASURED AND NOT PROMOTED.
//
// There is no `geo-scope-v1` arm any more: selecting it would mean selecting
// the default. Its counterpart control is `pre-geo-control`, the same pattern
// `reason-v1` follows for the reason rules.
// ---------------------------------------------------------------------------

/** Pass 1 on the pre-geo base. `pre-geo-control`. */
export const CLOUD_RELEVANCE_SYSTEM_PROMPT_PRE_GEO = CLOUD_BASE_SLOTS["scoring/cloud-relevance-system-prompt-pre-geo"];

/** Headline pass 1 on the pre-geo base. `pre-geo-control`. */
export const CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT_PRE_GEO = CLOUD_BASE_SLOTS["scoring/cloud-headline-relevance-system-prompt-pre-geo"];

/** Pass 2 as shipped, on the pre-geo base. `pre-geo-control`. */
export const CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO = CLOUD_BASE_SLOTS["scoring/cloud-reason-system-prompt-pre-geo"];

/** Headline pass 2 as shipped, on the pre-geo base. `pre-geo-control`. */
export const CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO = CLOUD_BASE_SLOTS["scoring/cloud-headline-reason-system-prompt-pre-geo"];

/**
 * Pass 2 under the object contract, on the SHIPPED base. `reason-rescore`,
 * `reason-rescore-prior` and `rescore-demote-only` all use this one string:
 * the first two differ only in the USER message, the third only in what the
 * caller does with the score. None of them changes the prompt again.
 *
 * MEASURED AND NOT PROMOTED. Pass 2, seeing one article, is systematically more
 * conservative than the batched pass 1: every rescore arm deflated (mean signed
 * delta -0.027 to -0.155, band-down 15 to 63 against band-up 0 to 7) and cut
 * broad-set recall by roughly 0.08, which is eight times the null floor. The
 * decode plumbing stays shipped and INERT: the shipped prompts never ask for an
 * object, so `extractRescore` never fires outside these arms.
 */
export const CLOUD_REASON_SYSTEM_PROMPT_RESCORE = CLOUD_BASE_SLOTS["scoring/cloud-reason-system-prompt-rescore"];

/** The headline twin of {@link CLOUD_REASON_SYSTEM_PROMPT_RESCORE}. On the
 *  no-anchors base for the same wire-cap reason as the shipped headline reason
 *  prompt: with anchors it is 70058 on the wire and could never be submitted,
 *  so the arm would have been unrunnable rather than merely unmeasured. */
export const CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE = CLOUD_BASE_SLOTS["scoring/cloud-headline-reason-system-prompt-rescore"];


// ---------------------------------------------------------------------------
// (The RELEVANCE v3 two-axis score prompts — CLOUD_SCORE_V3_SYSTEM_PROMPT, its
// headline twin, CLOUD_TWO_AXIS_BLOCK, ScoreV3Entry and parseScoreV3Response —
// were deleted with the v3 scorer. `cleanWhy` below survives them because
// parseV3NoteResponse (the `legacyNoteDemote` pass-2 decoder) shares it.)
// ---------------------------------------------------------------------------

/**
 * The prompt's own `Relevance Score: 0.62` label, echoed back by the model.
 * Replace with `'$1'` to keep the boundary it matched after.
 *
 * Only an ECHOED LABEL, never prose: it must sit at the start of the text, a
 * line, or a sentence (a `##` or `-` marker allowed), carry the prompt's colon,
 * and carry a number. Without the colon, "work. Relevance score 0.8 reflects
 * that." is prose and stripping it ships "work. reflects that.". Callers strip
 * an echoed "Why this matters to you:" first, so a label behind it starts the text. The old unanchored form ate
 * "relevance score." out of "warranting a high-relevance score." and shipped
 * "warranting a high-", hiding the phrase from the score guard that would have
 * rejected the whole note. Not `^`-only: the local reason builder puts the
 * label LAST, so a trailing echo is real.
 */
export const ECHOED_SCORE_LABEL = /(^|[.!?]\s*)[#\-\s]*\*?\*?Relevance Score:\s*\d[\d.]*\*?\*?/gim;

/**
 * Cut to `max` characters at a word boundary.
 *
 * The prompt asks for 25 words or fewer, so reaching the cap already means
 * something went wrong upstream. The old `slice(0, max)` then made it visibly
 * broken by cutting mid-word. No ellipsis: a trailing "…" dresses a failure up
 * as an intentional summary. A single token longer than the cap has no boundary
 * to cut at, so it is hard-cut rather than emptied.
 */
export function cutAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

/** Strip the markdown/prefix noise the reason parser also strips, collapse
 *  whitespace, and cap the length (same 200-char cap as parseReasonResponse, so
 *  a note cannot exceed what the legacy path could persist). */
function cleanWhy(raw: string): string {
  const text = raw
    .replace(/\*?\*?\[User facts\]\*?\*?.*$/gm, '')
    .replace(/\*?\*?Why this matters to you:?\*?\*?\s*/gi, '')
    .replace(ECHOED_SCORE_LABEL, '$1')
    .replace(/[*#]+/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cutAtWordBoundary(text, 200);
}


/**
 * Second-pass FEED verifier (cloud). Runs ONLY over the articles the first pass
 * scored into the FEED band (raw ≥ discardFloor, ~200/1000). Its narrow job is
 * precision: strike the CLEAR first-pass false positives — articles that only
 * share a keyword / place name / topic with the user but carry no real stake —
 * and KEEP everything else. Default is KEEP; it demotes ("no") only on a clear
 * NO-pattern. Batched (feedVerifierBatchSize/article), terse yes/no output.
 *
 * DESIGN NOTE (for humans — do NOT explain to the model): validated 2026-07-16
 * against the golden-labeled 1000-article prod run (multistage experiment,
 * "Design A2 — tuned"). Two stable runs lifted FEED precision 73.2%→80.4% and
 * cut unrelated(EXCLUDE)-in-FEED 19→13 for +3.8% tokens, at a small recall cost
 * (78.5%→~76%). This is the GENERALIZED form of that experiment's persona-
 * hardcoded VERIFIER2_SYSTEM: every rule now references the [User facts] block
 * generically and mirrors CLOUD_SCORING_BASE_PROMPT's hard rules (no-holdings ⇒
 * no market relevance, foreign-domestic ⇒ demote, origin ≠ residence, place-
 * keyword-alone, lifestyle filler, exec-opinion / AI-race chatter, digests,
 * flagship-industry disputes = home-structural). Removing a NO pattern or
 * flipping the KEEP default requires re-running the golden eval.
 */
export const CLOUD_FEED_VERIFIER_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-feed-verifier-system-prompt"];

/**
 * Pass 1 (local, Qwen3.5-4B) — Relevance score for one article per call.
 * Single-article framing keeps full attention on the rubric.
 */
export const LOCAL_RELEVANCE_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/local-relevance-system-prompt"];

/**
 * Pass 2 (local, Qwen3.5-4B) — Reason generation. 4-tier tone table — the
 * 3.5-4B calibrates tone reliably across four buckets, unlike the prior 3-tier
 * compression which collapsed mid-bucket nuance.
 */
export const LOCAL_REASON_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/local-reason-system-prompt"];


/** A related fact's statement is capped here (raw chars, as before places existed). */
export const RELATED_FACT_MAX_CHARS = 200;
/** The " (news from: ...)" suffix `relatedFactLine` appends after the capped statement. */
export const RELATED_FACT_PLACES_MAX_CHARS = 180;
/** The whole line's cap in the builders: never cuts the suffix, so a long statement
 *  cannot cut a place name ("news from: " is 13 chars, plus the closing paren). */
const RELATED_FACT_LINE_MAX_CHARS = RELATED_FACT_MAX_CHARS + 14 + RELATED_FACT_PLACES_MAX_CHARS;

/**
 * Renders one article as a nonce-fenced block.
 *
 * Shared by every builder that emits `===== Article N =====` framing, so the
 * three of them cannot drift apart. The banner and the field labels sit OUTSIDE
 * the fence because they are our structure; every publisher-controlled value
 * sits inside it and has been through `asUntrusted`.
 */
function buildFencedArticleBlock(
  article: {
    title: string;
    description: string;
    country?: string;
    /** "Diario de Noticias (Portuguese)" — publisher and language, prebuilt by
     *  the caller. Optional, and omitted from the block when absent, so a call
     *  site that does not supply it produces the pre-change bytes exactly. */
    publication?: string;
    relatedFacts?: string[];
  },
  index: number,
  nonce: string,
  /** Publisher title/description cap. Undefined keeps `asUntrusted`'s 500-char
   *  default, which is what every shipped call does. */
  textMaxLength?: number,
): string {
  // Omit the Article Country line entirely when the publication has no real
  // country scope — a missing value or a 'GLOBAL' placeholder carries no
  // location signal, and feeding it in just adds noise to the prompt.
  const country = asUntrusted(article.country ?? '', 60);
  const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
  const countryLine = hasCountry ? `\nArticle Country: ${country}` : '';
  // WHY THIS LINE EXISTS. The article's own country column is nullable and is
  // routinely 'GLOBAL', and when it is missing the model had NO geographic
  // signal at all — measured, it then defaults to the reader's country on a
  // strong fact match and scores a foreign story `home` 0.85. The publisher and
  // its language are already on the suggestion row and were simply never sent.
  const publication = asUntrusted(article.publication ?? '', 120);
  const publicationLine = publication.length > 0 ? `\nPublication: ${publication}` : '';
  const related = (article.relatedFacts ?? [])
    .map((f) => asUntrusted(f, RELATED_FACT_LINE_MAX_CHARS))
    .filter((f) => f.length > 0)
    .join('; ') || 'none';
  // Passing `undefined` through hits asUntrusted's own default parameter, so
  // the no-variant path is the same call it always was.
  const body =
    `News Title: ${asUntrusted(article.title, textMaxLength)}`
    + `\nNews Description: ${asUntrusted(article.description, textMaxLength)}`
    + `${countryLine}`
    + `${publicationLine}`
    + `\nRelated User Fact: ${related}`;
  return `===== Article ${index} =====\n${fenceArticleBlock(nonce, body)}`;
}

/**
 * Builds the user message for batched relevance scoring (Pass 1).
 * Pairs with CLOUD_RELEVANCE_SYSTEM_PROMPT / LOCAL_RELEVANCE_SYSTEM_PROMPT — emits user facts once + each article
 * framed as `===== Article N =====`. The LLM returns a JSON array of N scores
 * in input order.
 */
export function buildBatchScoringUserMessage(params: {
  userContext: string;
  articles: {
    title: string;
    description: string;
    country?: string;
    relatedFacts?: string[];
  }[];
  /** v3 merged path: the trailer must ask for the two-axis OBJECT schema, not
   *  the legacy "N numbers" line — a contradictory trailer is the last thing
   *  the model reads and wins format fights against the system prompt. */
  v3?: boolean;
  /** Injectable so tests can pin the fence; production takes a fresh random
   *  token per build, which is what makes the close marker unforgeable. */
  nonce?: string;
  /** Experiment arm. Omitted or 'baseline' ⇒ byte-identical output. */
  promptVariant?: PromptVariantId;
}): string {
  const { userContext, articles, v3 } = params;
  const nonce = params.nonce ?? newPromptNonce();
  const { articleTextMaxLength } = resolvePromptVariant(params.promptVariant);
  const blocks = articles.map((a, i) =>
    buildFencedArticleBlock(a, i, nonce, articleTextMaxLength),
  );
  const trailer = v3
    ? `Return a JSON array of ${articles.length} objects ({"i","rel","impact"}), one per article, in order.`
    : `Return a JSON array of ${articles.length} numbers (one per article, in order).`;
  return `User Context: ${userContext}\n\n${blocks.join('\n\n')}\n\n${trailer}`;
}

/**
 * Builds the user message for the second-pass FEED verifier.
 * Pairs with CLOUD_FEED_VERIFIER_SYSTEM_PROMPT. Uses the SAME article-block
 * format as buildBatchScoringUserMessage (so the model sees identical framing),
 * but the trailing instruction asks for a yes/no keep/demote array instead of
 * numeric scores.
 */
export function buildFeedVerifierUserMessage(params: {
  userContext: string;
  articles: {
    title: string;
    description: string;
    country?: string;
    relatedFacts?: string[];
  }[];
  /** See `buildBatchScoringUserMessage` — injectable for tests only. */
  nonce?: string;
  /** Experiment arm. Omitted or 'baseline' ⇒ byte-identical output. */
  promptVariant?: PromptVariantId;
}): string {
  const { userContext, articles } = params;
  const nonce = params.nonce ?? newPromptNonce();
  const { articleTextMaxLength } = resolvePromptVariant(params.promptVariant);
  const blocks = articles.map((a, i) =>
    buildFencedArticleBlock(a, i, nonce, articleTextMaxLength),
  );
  return `User Context: ${userContext}\n\n${blocks.join('\n\n')}\n\nReturn a JSON array of ${articles.length} objects ({"v":"yes"} to keep or {"v":"no"} to demote), one per article, in order.`;
}

// ---------------------------------------------------------------------------
// v3 PASS 2 — one article per call: keep-or-demote, and the sentence.
//
// WHY THIS IS A SEPARATE CALL. v3 originally merged scoring and the note into
// one batched response. Replaying the frozen gold set showed the cost: 4.9% of
// notes described a DIFFERENT article than the one they sat on — adjacent slots
// literally holding each other's sentences — while the array came back
// correctly numbered `"i"` 1..N, in input order. The model emits the RIGHT index
// with the WRONG prose, so no index scheme can catch it; only removing the
// neighbouring articles from the context does. Measured on 292 articles, moving
// the note here took that from 4.9% to 0.5% (and the residue is a false positive
// of the grounding check) while ranking held: r 0.493 -> 0.507, must_show recall
// tied at 29/33. The on-device path reached the same conclusion independently —
// LOCAL_ARTICLES_PER_SCORE_PROMPT is 1 because per-article attention wins.
//
// It also does a SECOND job, because it is already looking at exactly the right
// population. v3 dropped the demote-only verifier pass when it merged everything
// into one call, and nothing replaced the downward pressure: 45.1% of what
// cleared the gate was judged "skip" by the blind panel. Folding the verifier in
// here took that to 36.9% at no extra call — the same rows needed visiting
// anyway.
//
// The precision half REUSES CLOUD_FEED_VERIFIER_SYSTEM_PROMPT verbatim rather
// than restating its rules: those NO-patterns were validated against the golden
// 1000-article run (FEED precision 73.2% -> 80.4%), and a second copy would drift
// from them. Only the output contract is replaced, since the verifier's own is
// written for a batch.
// ---------------------------------------------------------------------------

/**
 * v3 pass 2 — the combined precision + note prompt, ONE article per call.
 * Pairs with {@link buildReasonUserMessage} (unchanged — it already carries the
 * article, its score and the retrieval facts) and is decoded by
 * {@link parseV3NoteResponse}.
 */
export const CLOUD_V3_NOTE_SYSTEM_PROMPT = CLOUD_BASE_SLOTS["scoring/cloud-v3-note-system-prompt"];

/** One decoded v3 pass-2 verdict. */
export interface V3NoteVerdict {
  /** False ⇒ the precision pass rejected it; the caller demotes the score. */
  keep: boolean;
  /** The user-facing sentence. Always null when `keep` is false. */
  why: string | null;
}

/**
 * Decode a v3 pass-2 response: one `{"keep":bool,"why"?:string}` object.
 *
 * Returns `null` on anything unusable, which callers FAIL OPEN on — the pass-1
 * score stands and the row simply still owes a note, exactly as a failed reason
 * call behaves today. That asymmetry is deliberate: an unreadable response is
 * not evidence the article should be demoted, and treating it as one would let a
 * transient decode failure silently hide a story.
 */
export function parseV3NoteResponse(text: string): V3NoteVerdict | null {
  const trimmed = (text ?? '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.keep !== 'boolean') return null;
  if (!o.keep) return { keep: false, why: null };
  const why = typeof o.why === 'string' ? cleanWhy(o.why) : '';
  return { keep: true, why: why.length > 0 ? why : null };
}

/**
 * Builds the user message for reason generation (Pass 2).
 * Includes the already-computed relevance score for context.
 */
export function buildReasonUserMessage(params: {
  userContext: string;
  articleTitle: string;
  articleDescription: string;
  articleCountry?: string;
  relevance: number;
  /** Subset of user facts that triggered this article's retrieval. Surfaced so
   *  the reason generator can point at the exact connecting fact. */
  relatedFacts?: string[];
  /** Publisher and language, e.g. "Diario de Noticias (Portuguese)". CLOUD
   *  only; the local builder has no such parameter. */
  publication?: string;
  /** See `buildBatchScoringUserMessage` — injectable for tests only. */
  nonce?: string;
  /** Experiment arm. Omitted or 'baseline' ⇒ byte-identical output.
   *  Deliberately absent from `buildLocalReasonUserMessage`: the on-device
   *  prompt family is out of scope for prompt experiments and must stay
   *  byte-identical, so the seam stops at the cloud builder. */
  promptVariant?: PromptVariantId;
}): string {
  const { userContext, articleTitle, articleDescription, articleCountry, relevance, relatedFacts } = params;
  const nonce = params.nonce ?? newPromptNonce();
  const { articleTextMaxLength, reasonPriorScoreLine } = resolvePromptVariant(params.promptVariant);
  const fenced = buildFencedReasonBody({
    articleTitle,
    articleDescription,
    articleCountry,
    relatedFacts,
    nonce,
    textMaxLength: articleTextMaxLength,
    publication: params.publication,
  });
  // Absent ⇒ the shipped line, byte for byte. That is what keeps `baseline` a
  // no-op and `golden-prompts.test.ts` pinning a real string rather than a
  // branch that happens to agree today.
  const priorLine =
    reasonPriorScoreLine === 'omit'
      ? ''
      : reasonPriorScoreLine === 'relabel'
        ? `First-pass score (batched): ${relevance}\n\n`
        : `Relevance Score: ${relevance}\n\n`;
  return `${priorLine}User Context: ${userContext}\n\n${fenced}`;
}

/**
 * The publisher-controlled half of a reason prompt, nonce-fenced.
 *
 * Shared by the cloud and local reason builders so the two cannot drift in
 * anything except the FIELD ORDER they deliberately differ on.
 */
function buildFencedReasonBody(params: {
  articleTitle: string;
  articleDescription: string;
  articleCountry?: string;
  relatedFacts?: string[];
  nonce: string;
  textMaxLength?: number;
  /** See `buildFencedArticleBlock`. Passed by the CLOUD reason builder only;
   *  `buildLocalReasonUserMessage` deliberately omits it, which is what keeps
   *  the on-device prompt byte-identical. */
  publication?: string;
}): string {
  const { articleTitle, articleDescription, articleCountry, relatedFacts, nonce, textMaxLength, publication: pubRaw } = params;
  // Omit the Article Country line entirely when the publication has no real
  // country scope — a missing value or a 'GLOBAL' placeholder carries no
  // location signal, and feeding it in just adds noise to the prompt.
  const country = asUntrusted(articleCountry ?? '', 60);
  const hasCountry = country.length > 0 && country.toUpperCase() !== 'GLOBAL';
  const countryLine = hasCountry
    ? `\n\nArticle Country (publication's country — use as the article's scope ONLY when the title/description names no location): ${country}`
    : '';
  const related = (relatedFacts ?? [])
    .map((f) => asUntrusted(f, RELATED_FACT_LINE_MAX_CHARS))
    .filter((f) => f.length > 0)
    .join('; ') || 'none';
  const publication = asUntrusted(pubRaw ?? '', 120);
  const publicationLine = publication.length > 0 ? `\n\nPublication: ${publication}` : '';
  const body =
    `News Title: ${asUntrusted(articleTitle, textMaxLength)}`
    + `\n\nNews Description: ${asUntrusted(articleDescription, textMaxLength)}`
    + `${countryLine}`
    + `${publicationLine}`
    + `\n\nRelated User Fact: ${related}`;
  return fenceArticleBlock(nonce, body);
}

/**
 * Local-only variant of {@link buildReasonUserMessage}: same content, ordered so
 * llama.cpp's prefix cache can actually reuse it across a batch.
 *
 * The shared builder opens with `Relevance Score: <float>`, which differs for
 * every article. llama.cpp reuses only the COMMON PREFIX between consecutive
 * calls, so that float terminates the reusable span almost immediately and the
 * whole `userContext` fact bank — byte-identical across every article in a
 * batch — gets re-prefilled once per article. Putting `User Context` first
 * extends the cached prefix by the entire fact bank; everything after it varies
 * per article and would be re-prefilled under any ordering.
 *
 * This exists as a separate function rather than a fix to the shared builder
 * because `golden-prompts.test.ts` pins the shared one byte-for-byte against the
 * harness twin, and cloud reason quality is calibrated against `eval:golden`
 * runs that use it. Cloud output stays byte-unchanged; only the on-device path
 * sees this ordering.
 *
 * LLMs are order-sensitive, so this is a quality change as well as a latency
 * one — it needs an eval run, not just a passing type-check.
 */
export function buildLocalReasonUserMessage(params: {
  userContext: string;
  articleTitle: string;
  articleDescription: string;
  articleCountry?: string;
  relevance: number;
  relatedFacts?: string[];
  /** See `buildBatchScoringUserMessage` — injectable for tests only. */
  nonce?: string;
}): string {
  const { userContext, articleTitle, articleDescription, articleCountry, relevance, relatedFacts } = params;
  // The nonce lands AFTER `User Context`, so the fact bank — the whole point of
  // this ordering — is still a byte-identical shared prefix across the batch.
  // Everything from the fence marker on varies per article under any ordering.
  const nonce = params.nonce ?? newPromptNonce();
  const fenced = buildFencedReasonBody({
    articleTitle,
    articleDescription,
    articleCountry,
    relatedFacts,
    nonce,
  });
  return `User Context: ${userContext}\n\n${fenced}\n\nRelevance Score: ${relevance}`;
}
