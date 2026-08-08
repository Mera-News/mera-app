/**
 * Pure state/copy logic for the article fact check.
 *
 * Everything here is a total function over server-supplied strings. That
 * matters more than usual: `FactCheck.status`, `FactCheck.verdict` and
 * `FactCheckClaim.assessment` are all plain `String` in the schema, NOT
 * enums — the model on the other end can and will emit a value this build has
 * never seen. Every normalizer therefore has an explicit unknown bucket that
 * falls through to generic, hedged copy. Rendering a raw model token, or an
 * empty verdict row, is the failure this file exists to prevent.
 *
 * No React, no network, never throws.
 */

/** Lifecycle values the server documents. `complete` and `blocked` are terminal. */
export type FactCheckStatus = 'pending' | 'running' | 'complete' | 'failed' | 'blocked';

/** Verdicts the server documents, plus the catch-all for anything else. */
export type FactCheckVerdict =
    | 'supported'
    | 'disputed'
    | 'unsupported'
    | 'mixed'
    | 'unverifiable'
    | 'unknown';

/** Per-claim assessment buckets. Undocumented server-side, so inferred. */
export type FactCheckAssessment =
    | 'supported'
    | 'disputed'
    | 'unsupported'
    | 'unverifiable'
    | 'unknown';

/**
 * Visual weight for a verdict chip. There is deliberately NO 'negative'/red
 * tone: this is an LLM's reading of a news story, and a confident red "false"
 * badge on a story that is actually true is the single worst outcome this
 * feature can produce. The strongest signal the UI gives is 'caution'.
 */
export type FactCheckTone = 'positive' | 'caution' | 'neutral';

/** Where the fact-check UI currently is. Drives the panel's render. */
export type FactCheckPhase = 'idle' | 'working' | 'ready' | 'timeout' | 'error';

/** Poll cadence once the request is in flight (server contract: ~3s). */
export const POLL_INTERVAL_MS = 3000;
/** Give up polling after this long and tell the reader to come back. */
export const POLL_TIMEOUT_MS = 60_000;
/**
 * A spinner is only honest if the wait is perceptible. A cross-user cache hit
 * returns `complete` on the very first round trip, so anything shorter than
 * this renders as a flash of "Checking…" replaced instantly by the result —
 * which reads as a glitch, not as speed.
 */
export const PROGRESS_DELAY_MS = 400;

const TERMINAL: ReadonlySet<string> = new Set(['complete', 'blocked']);

/**
 * True once the row will never change again. `failed` is deliberately NOT
 * terminal: the server records `attempts` and fails over between models, so a
 * `failed` observation mid-poll can still become `complete`. It is only
 * reported as a failure if it is what we last saw when the deadline hit.
 */
export function isTerminalStatus(status: string | null | undefined): boolean {
    return typeof status === 'string' && TERMINAL.has(status.trim().toLowerCase());
}

const VERDICTS: ReadonlySet<string> = new Set([
    'supported', 'disputed', 'unsupported', 'mixed', 'unverifiable',
]);

/** Maps a raw server verdict onto a known bucket; anything else → 'unknown'. */
export function normalizeVerdict(raw: string | null | undefined): FactCheckVerdict {
    if (typeof raw !== 'string') return 'unknown';
    const key = raw.trim().toLowerCase();
    return VERDICTS.has(key) ? (key as FactCheckVerdict) : 'unknown';
}

const VERDICT_TONE: Record<FactCheckVerdict, FactCheckTone> = {
    supported: 'positive',
    mixed: 'caution',
    disputed: 'caution',
    unsupported: 'caution',
    unverifiable: 'neutral',
    unknown: 'neutral',
};

/**
 * Everything the verdict chip needs: the normalized bucket, the two i18n keys
 * (a short label and a hedged one-line explanation), and the tone.
 *
 * The label/detail split exists because the label alone can't carry the hedge —
 * "Sources disagree" is short enough to sit in a chip, but the reader also
 * needs to be told, in the same breath, that a machine wrote it.
 */
export function describeVerdict(raw: string | null | undefined): {
    verdict: FactCheckVerdict;
    labelKey: string;
    detailKey: string;
    tone: FactCheckTone;
} {
    const verdict = normalizeVerdict(raw);
    return {
        verdict,
        labelKey: `factCheck.verdict.${verdict}.label`,
        detailKey: `factCheck.verdict.${verdict}.detail`,
        tone: VERDICT_TONE[verdict],
    };
}

const ASSESSMENTS: ReadonlySet<string> = new Set([
    'supported', 'disputed', 'unsupported', 'unverifiable',
]);

const ASSESSMENT_TONE: Record<FactCheckAssessment, FactCheckTone> = {
    supported: 'positive',
    disputed: 'caution',
    unsupported: 'caution',
    unverifiable: 'neutral',
    unknown: 'neutral',
};

/**
 * Per-claim equivalent of {@link describeVerdict}. `assessment` is a bare
 * `String` with no documented vocabulary at all, so the unknown bucket here is
 * the expected path for at least some models, not an edge case.
 */
export function describeAssessment(raw: string | null | undefined): {
    assessment: FactCheckAssessment;
    labelKey: string;
    tone: FactCheckTone;
} {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const assessment: FactCheckAssessment = ASSESSMENTS.has(key)
        ? (key as FactCheckAssessment)
        : 'unknown';
    return {
        assessment,
        labelKey: `factCheck.assessment.${assessment}`,
        tone: ASSESSMENT_TONE[assessment],
    };
}

/**
 * Whether to render the "Checking…" progress state.
 *
 * Only `working` can show progress at all, and only once the wait has been long
 * enough to be worth acknowledging — see {@link PROGRESS_DELAY_MS}. An already
 * fact-checked article (the cross-user cache hit) therefore goes tap → result
 * with no intermediate spinner.
 */
export function shouldShowProgress(phase: FactCheckPhase, elapsedMs: number): boolean {
    return phase === 'working' && elapsedMs >= PROGRESS_DELAY_MS;
}

/**
 * Which copy the timeout state uses, branched on the last status observed.
 *
 * A run that was still `pending`/`running` at the deadline is genuinely just
 * slow — "still working, check back". A run whose last observation was `failed`
 * is a different message: the check did not produce an answer. Collapsing the
 * two would tell a reader to come back to something that is never coming.
 */
export function timeoutCopyKey(lastStatus: string | null | undefined): string {
    const key = typeof lastStatus === 'string' ? lastStatus.trim().toLowerCase() : '';
    return key === 'failed' ? 'factCheck.failed' : 'factCheck.stillWorking';
}
