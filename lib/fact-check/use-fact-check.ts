/**
 * The fact-check request driver for the article detail screens.
 *
 * THERE IS NO POLLING HERE ANY MORE. The old shape was: mutate, poll `factCheck`
 * every 3s, and at 60s declare a "timeout" and tell the reader to come back.
 * Every part of that was wrong. The deadline was a client-side invention the
 * server never agreed to; a check that legitimately takes two minutes rendered
 * as a failure; and a reader who left the screen — which is what a reader does
 * when told to wait a minute — threw the answer away, because nothing persisted
 * it. Twenty polls per check bought exactly one thing the first response did not
 * already provide: the answer, if it happened to land inside the window.
 *
 *   idle ──tap──► working ──terminal row──► ready
 *                    │
 *                    ├──non-terminal row──► queued  ("we'll tell you")
 *                    └──mutation threw────► error
 *
 * Three behaviours are load-bearing:
 *
 * 1. The MUTATION'S OWN RETURN is the result. The server caches fact checks
 *    across users (`$setOnInsert`), so an article somebody else already checked
 *    comes back `complete` from `requestFactCheck` itself — the common fast
 *    path, and it renders with no spinner because of (2).
 * 2. Progress is gated behind `PROGRESS_DELAY_MS`, so a cache hit goes tap →
 *    verdict with nothing in between.
 * 3. EVERY observation is written to `fact_checks` on the device. That is what
 *    makes leaving the screen free: the answer has somewhere to land, the
 *    Dashboard can list it, and the push handler can fill it in later.
 *
 * The mount read is deliberately NOT "query the server on every article open".
 * It reads the local table first (free, offline, and the only thing most opens
 * need), and only spends a network call when a locally-stored row is still
 * unresolved — i.e. the user asked before and the answer may have landed since.
 * An article nobody on this device ever asked about costs nothing until it is
 * tapped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getFactCheckForArticle,
    upsertFactCheck,
} from '../database/services/fact-check-record-service';
import logger from '../logger';
import { FactCheckService, type FactCheckRow } from './fact-check-service';
import {
    isTerminalStatus,
    PROGRESS_DELAY_MS,
    shouldShowProgress,
    type FactCheckPhase,
} from './fact-check-state';

export interface UseFactCheckOptions {
    /**
     * Whether the feature is switched on for this user. Default true.
     *
     * Load-bearing: the panel's own `factCheckEnabled` gate returns null AFTER
     * this hook has run (hook order can't change across renders), so without
     * this flag the mount read would fire on every article open even for a user
     * who has fact-checking off — and the resolvers sit behind
     * `SubscriptionGuard`, so on a free plan that is a guaranteed rejection per
     * article opened.
     */
    readonly enabled?: boolean;
    /** Article headline, stored alongside the result so the Dashboard's list
     *  can name the story after the article row has aged out. */
    readonly articleTitle?: string | null;
}

export interface UseFactCheckResult {
    phase: FactCheckPhase;
    /** The completed (or blocked) row. Only meaningful when phase is 'ready'. */
    result: FactCheckRow | null;
    /** True only once the wait has been long enough to deserve a spinner. */
    showProgress: boolean;
    /** Start (or re-start) a check. No-op while one is already running. */
    start: () => void;
    /** Collapse the panel back to 'idle'. The stored row is untouched. */
    dismiss: () => void;
}

export function useFactCheck(
    articleId: string | null | undefined,
    options: UseFactCheckOptions = {},
): UseFactCheckResult {
    const { enabled = true, articleTitle = null } = options;
    const [phase, setPhase] = useState<FactCheckPhase>('idle');
    const [result, setResult] = useState<FactCheckRow | null>(null);
    const [elapsedMs, setElapsedMs] = useState(0);

    // Monotonic run id: every settle/cancel path compares against it, so a
    // late-arriving response from an abandoned run (unmount, article change,
    // dismiss) can never write state.
    const runIdRef = useRef(0);
    const runningRef = useRef(false);
    const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearTimers = useCallback(() => {
        if (progressTimerRef.current) {
            clearTimeout(progressTimerRef.current);
            progressTimerRef.current = null;
        }
    }, []);

    // Abandon any run and reset when the screen switches article, and on
    // unmount. Chaining into a related article must not show the previous
    // article's verdict for even one frame.
    useEffect(() => {
        return () => {
            runIdRef.current += 1;
            runningRef.current = false;
            clearTimers();
        };
    }, [articleId, clearTimers]);

    useEffect(() => {
        setPhase('idle');
        setResult(null);
        setElapsedMs(0);
    }, [articleId]);

    /** Mirror an observation into the on-device table. Fire-and-forget: the
     *  service swallows its own failures, and a failed write must never stop a
     *  result the reader is already looking at from rendering. */
    const persist = useCallback((row: FactCheckRow) => {
        if (!articleId || !row) return;
        void upsertFactCheck({
            articleId,
            factCheckId: String(row._id ?? ''),
            articleTitle: row.articleTitle ?? articleTitle ?? null,
            status: row.status,
            verdict: row.verdict ?? null,
            payload: row,
        });
    }, [articleId, articleTitle]);

    // ── Mount read: ONE look, never a loop ──────────────────────────────────
    useEffect(() => {
        if (!articleId || !enabled) return;
        const run = ++runIdRef.current;
        const alive = () => runIdRef.current === run;
        let cancelled = false;

        (async () => {
            const stored = await getFactCheckForArticle(articleId);
            if (cancelled || !alive()) return;

            if (stored && isTerminalStatus(stored.status) && stored.payload) {
                setResult(stored.payload as FactCheckRow);
                setPhase('ready');
                return;
            }
            if (!stored) return; // Nobody asked on this device — stay idle, spend nothing.

            // A stored-but-unresolved row: the user asked earlier and the answer
            // may have landed since. Exactly one server read — no retry, no
            // interval. If it is still not ready, say so and stop.
            setPhase('queued');
            try {
                const row = await FactCheckService.getFactCheck(articleId);
                if (cancelled || !alive() || !row) return;
                persist(row);
                if (isTerminalStatus(row.status)) {
                    setResult(row);
                    setPhase('ready');
                }
            } catch (err) {
                // Offline, or the plan does not cover this. Neither is worth an
                // error report on a passive read the user never asked for — the
                // stored row is still on screen.
                logger.debug('[useFactCheck] mount read failed', {
                    articleId,
                    error: String(err),
                });
            }
        })();

        return () => { cancelled = true; };
    }, [articleId, enabled, persist]);

    const start = useCallback(() => {
        if (!articleId || runningRef.current) return;
        runningRef.current = true;
        const run = ++runIdRef.current;
        const alive = () => runIdRef.current === run;
        clearTimers();

        setPhase('working');
        setResult(null);
        setElapsedMs(0);

        progressTimerRef.current = setTimeout(() => {
            if (alive()) setElapsedMs(PROGRESS_DELAY_MS);
        }, PROGRESS_DELAY_MS);

        FactCheckService.requestFactCheck(articleId)
            .then((row) => {
                if (!alive()) return;
                clearTimers();
                runningRef.current = false;
                if (row) persist(row);
                // The cross-user cache hit: already complete, render it now.
                if (row && isTerminalStatus(row.status)) {
                    setResult(row);
                    setPhase('ready');
                    return;
                }
                // Everything else — pending, running, failed-and-will-be-retried,
                // or a null row — is the same fact from the reader's side: the
                // request is lodged and the answer is not here. Say that, and
                // stop. No timer is armed; leaving the screen costs nothing.
                setPhase('queued');
            })
            .catch((err) => {
                if (!alive()) return;
                logger.captureException(err, {
                    tags: { hook: 'useFactCheck', method: 'requestFactCheck' },
                    extra: { articleId },
                });
                clearTimers();
                runningRef.current = false;
                setPhase('error');
            });
    }, [articleId, clearTimers, persist]);

    const dismiss = useCallback(() => {
        runIdRef.current += 1;
        runningRef.current = false;
        clearTimers();
        setPhase('idle');
        setResult(null);
        setElapsedMs(0);
    }, [clearTimers]);

    return {
        phase,
        result,
        showProgress: shouldShowProgress(phase, elapsedMs),
        start,
        dismiss,
    };
}
