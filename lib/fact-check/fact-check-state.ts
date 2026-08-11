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

/**
 * Where the fact-check UI currently is. Drives the panel's render.
 *
 * `queued` replaced the old `timeout`, and the difference is the whole point of
 * the rewrite. `timeout` was a client-side fiction: the app polled for 60s and
 * then declared a deadline the server had never agreed to. `queued` is a
 * statement of fact — the request is lodged, the answer is not here yet, and
 * nothing about staying on this screen makes it arrive sooner.
 */
export type FactCheckPhase = 'idle' | 'working' | 'ready' | 'queued' | 'error';

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
 * terminal: the server records `attempts`, fails over between models, and now
 * has a retry cron behind it, so a `failed` row is one the pipeline will pick
 * up again. There is no client-side deadline any more to turn that observation
 * into a verdict of failure — a non-terminal row of any status is simply
 * "not answered yet", which is what the `queued` phase says.
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
 * The fact-checking organisations that covered this story, cleaned up for
 * render.
 *
 * The server's `checkedBy` is a list of `{ organisation, url, verdict, summary
 * }`. Entries with no organisation name are dropped — a source link with
 * nothing to attribute it to is worse than no row, because the reader cannot
 * tell whose judgement they are being shown, and "whose judgement" is the
 * entire value of this list over the model's own summary.
 */
export function describeCheckedBy<
    T extends { organisation?: string | null },
>(entries: readonly T[] | null | undefined): T[] {
    if (!Array.isArray(entries)) return [];
    return entries.filter(
        (entry) => !!entry && typeof entry.organisation === 'string'
            && entry.organisation.trim().length > 0,
    );
}

/**
 * How to render ONE organisation's own published rating.
 *
 * This is the one place in this file where an unrecognised token is DISPLAYED
 * VERBATIM instead of being swallowed by an unknown bucket, and the distinction
 * is deliberate rather than an oversight of the rule at the top.
 *
 * The unknown buckets elsewhere exist because the string is a MODEL's opinion:
 * an unvetted token from an LLM must never render as though it were a finding.
 * An organisation's verdict is the opposite kind of object — a human editorial
 * rating, published under a masthead, attributed on screen, and linked. Fact
 * checkers do not use our five-word vocabulary: real ratings are "False",
 * "Mostly False", "Misleading", "Altered photo", "Pants on Fire". Routing those
 * through `describeAssessment` would collapse every one of them to "Unclear",
 * which does not hedge the claim — it DELETES it, and the per-organisation
 * verdict is the whole point of the `checkedBy` list.
 *
 * So: a token we recognise gets the localized label and its tone; anything else
 * is shown as written, in the neutral tone, because we cannot know whether a
 * rating we don't recognise is positive or cautionary. That makes this correct
 * whether or not the server normalizes its vocabulary.
 */
export function describeOrganisationVerdict(raw: string | null | undefined): {
    /** Either an i18n key or literal text — see `isKey`. */
    label: string;
    /** True ⇒ `label` must be passed through `t()`; false ⇒ render as-is. */
    isKey: boolean;
    tone: FactCheckTone;
} {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length === 0) {
        return {
            label: 'factCheck.assessment.unknown',
            isKey: true,
            tone: 'neutral',
        };
    }
    const key = trimmed.toLowerCase();
    if (ASSESSMENTS.has(key)) {
        return {
            label: `factCheck.assessment.${key}`,
            isKey: true,
            tone: ASSESSMENT_TONE[key as FactCheckAssessment],
        };
    }
    return { label: trimmed, isKey: false, tone: 'neutral' };
}
