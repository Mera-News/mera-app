/**
 * Pure state/copy logic for the article fact check.
 *
 * Everything here is a total function over server-supplied strings. That
 * matters more than usual: the server's `status`, `verdict` and
 * `FactCheckClaim.assessment` (see `fact-check-types.ts`) are plain strings,
 * NOT enums — the model behind them can and will emit a value this build has
 * never seen. Every normalizer therefore has an explicit unknown bucket that
 * falls through to generic, hedged copy. Rendering a raw model token, or an
 * empty verdict row, is the failure this file exists to prevent.
 *
 * No React, no network, never throws.
 */

/** Lifecycle values the runner writes. `complete` and `blocked` are terminal;
 *  `pending`/`running` are legacy (pre-pivot server statuses, still valid on an
 *  old stored row) and `processing` is the on-device runner's equivalent. */
export type FactCheckStatus = 'pending' | 'running' | 'processing' | 'complete' | 'failed' | 'blocked';

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
 * Where the fact-check UI currently is, for ONE article's stored rows. Drives
 * `FactCheckPanel`'s render and the action-row tick's icon.
 *
 * `useFactCheck` is a LIVE observer of the on-device table PLUS a bounded
 * server poll layered on top of it (pivot P8d re-added polling, deleted in
 * pivot P4 when the check briefly ran entirely on-device) — see
 * `POLL_INTERVAL_MS` / `POLL_CEILING_MS` below. That gives it four honest
 * things to say: nobody has asked (`absent`), a background job is running and
 * still within its poll window (`processing`), every asked-for row has an
 * answer (`terminal`, `blocked` included — the row will never change again;
 * see `isTerminalStatus`), or a poll ran out its window without a terminal
 * answer (`stalled`).
 *
 * `stalled` MUST NOT collapse into `absent` or render as nothing. r14 shipped
 * exactly that bug once already — a timed-out poll that looked identical to
 * "no result" — and it had to be fixed. `stalled` is a real UI state with its
 * own copy (`factCheck.stillChecking`) precisely so a reader can tell "still
 * working, ask again later" apart from "nobody has asked" or "checked, found
 * nothing".
 */
export type FactCheckPhase = 'absent' | 'processing' | 'terminal' | 'stalled';

/**
 * A spinner is only honest if the wait is perceptible. Reopening an article
 * whose check is already seconds old must not flash "Checking…" for 400ms
 * before rendering — the delay guards against a JUST-STARTED job, not against
 * showing an in-progress one truthfully.
 */
export const PROGRESS_DELAY_MS = 400;

/**
 * Poll cadence and ceiling for `useFactCheck`'s server layer.
 *
 * THE OLD 3s/60s WINDOW (pre-r14) WAS TOO SHORT FOR THIS DESIGN AND MUST NOT
 * COME BACK. It was sized for a client that did the whole job inline within
 * the request the reader was staring at. The async job this wave polls is the
 * opposite: it runs claim extraction, up to three web-search rounds, a
 * ClaimReview lookup and an LLM synthesis pass, server-side, on a schedule the
 * server controls and can retry — "no mobile deadline" is the whole point of
 * having moved it there. A client-side ceiling can therefore never be "the
 * job's real deadline"; it can only be "how long is it reasonable to keep an
 * open screen polling before saying so honestly and stopping."
 *
 * Chosen values, and why:
 *   - `POLL_INTERVAL_MS = 6s` — frequent enough that a check landing while the
 *     reader is still on the article feels immediate, infrequent enough that
 *     30 polls (see below) is a trivial request volume for a subscription-
 *     gated feature, not a hammering pattern.
 *   - `POLL_CEILING_MS = 3 minutes` (30 polls) — long enough to cover the
 *     realistic worst case measured for this pipeline (several search rounds
 *     plus one synthesis call, occasionally retried on a transient failure),
 *     short enough that a reader who genuinely stays on one article for three
 *     minutes without an answer is better served by an honest "still checking"
 *     state than an indefinite spinner. It is FIVE TIMES the old 60s ceiling,
 *     matching the 5x margin the r14 P2 poll-removal commit used when it
 *     needed to prove "no more polls after the old deadline" — the same
 *     multiple, now applied to widen the window instead of removing it.
 *
 * Reaching the ceiling stops polling — it does NOT retry forever and it does
 * NOT silently render like "no result" (see `FactCheckPhase.stalled`).
 * Leaving the screen and coming back (a fresh mount) starts a fresh, equally
 * bounded poll — the honest way to let a reader "check again" without a
 * client-invented notion of overall failure. The Dashboard's own bounded
 * per-row read (`FactChecksPanel`) is the other way an answer that lands after
 * the ceiling still reaches the reader.
 */
export const POLL_INTERVAL_MS = 6_000;
export const POLL_CEILING_MS = 180_000;

/** i18n key for the message the fact-check tick auto-sends as the user's
 *  opening chat turn — the SAME opening turn Mera AI's "Quick fact check"
 *  starter chip sends (see `open-fact-check-chat.ts`), so a tick tap and a
 *  chip tap land on the identical claim-picker pill list, which always ends
 *  with the async "The Article" option. Reuses the existing key rather than
 *  minting a new one: this is the string already shipped in 19 locales for
 *  this exact purpose pre-pivot. */
export const FACT_CHECK_SEED_MESSAGE_KEY = 'factCheck.chatSeed';

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

/**
 * How prominently to show OUR OWN verdict chip, given whether a named
 * fact-checking organisation has ALSO ruled on this story (`checkedBy`).
 *
 * BACKGROUND (pivot P8h). The server used to let a confident verdict through
 * on zero evidence — the failure mode a real screenshot caught: a green
 * "Consistent with sources" chip sitting directly above "No fact-checking
 * organisation we searched has published on this story" and "This check
 * didn't cite any specific pages." `clampVerdictToEvidence` now forces
 * `unverifiable` server-side when BOTH `citations` and `checkedBy` are empty
 * at write time. But `checkedBy` can fill in LATER on the re-check path (day
 * 0: nothing found, clamped to `unverifiable`; day 2: a fact-checker
 * publishes) and the verdict is deliberately NOT re-opened when that happens
 * — restoring the model's original ungrounded verdict would put back the very
 * answer the clamp exists to remove, and deriving a verdict from the
 * organisation's own rating would misquote a scale that isn't ours (see
 * `describeOrganisationVerdict`). So a row can now legitimately be
 * `verdict: 'unverifiable'` WITH a populated `checkedBy` — same shape of
 * contradiction as the screenshot, one hop later.
 *
 * `checkedBy` empty (the ~96% normal case) → `'lead'`: our own reading is the
 * only signal there is, so it renders exactly as before.
 *
 * `checkedBy` populated → an organisation's OWN verbatim rating is the
 * primary answer now, never ours — see `describeOrganisationVerdict`'s own
 * rationale for why it can't be routed through our vocabulary. Showing both
 * at equal weight is the exact contradiction this function exists to prevent,
 * so it is never `'lead'` in this branch:
 *   - our own verdict is `'unverifiable'` → `'suppressed'`. "Couldn't
 *     confirm" next to a named organisation's rating isn't a hedge, it's
 *     factually wrong — we DO have an answer, just not from us. There is
 *     nothing to lose by dropping a token that carries zero information here.
 *   - any other verdict → `'secondary'`. Our own AI reading (which claims it
 *     leaned on, its own hedge) may still be informative, so it stays, but
 *     demoted below the organisations and re-labelled so it can never be
 *     mistaken for a competing ruling — see `factCheck.ownReadingHeading`.
 */
export type VerdictPresentation = 'lead' | 'secondary' | 'suppressed';

export function describeVerdictPresentation(
    verdict: string | null | undefined,
    checkedByCount: number,
): VerdictPresentation {
    if (checkedByCount <= 0) return 'lead';
    return normalizeVerdict(verdict) === 'unverifiable' ? 'suppressed' : 'secondary';
}

/**
 * Whether to show the "these are independent, not a consensus" caveat above
 * the `checkedBy` list.
 *
 * Two or more organisations can rate the SAME claim differently, on scales
 * that are not comparable to each other (see `describeOrganisationVerdict`) —
 * nothing here ever averages, ranks or picks a "majority" verdict among them,
 * and the list itself already renders each rating independently. This is
 * purely a comprehension aid: without it, a reader skimming a list of two or
 * three named organisations could reasonably assume they agree just because
 * they are grouped under one heading.
 */
export function shouldShowMultipleOrganisationsCaveat(checkedByCount: number): boolean {
    return checkedByCount > 1;
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
 * Only `processing` can show progress at all, and only once the wait has been
 * long enough to be worth acknowledging — see {@link PROGRESS_DELAY_MS}.
 * `elapsedMs` is measured from the row's OWN `requested_at` (not from a mount
 * timer), so reopening an article whose check has genuinely been running for a
 * while shows the working state immediately rather than waiting out a second
 * artificial delay.
 */
export function shouldShowProgress(phase: FactCheckPhase, elapsedMs: number): boolean {
    return phase === 'processing' && elapsedMs >= PROGRESS_DELAY_MS;
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
