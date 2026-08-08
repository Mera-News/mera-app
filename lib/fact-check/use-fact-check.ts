/**
 * The fact-check request/poll driver for the article detail screens.
 *
 * Lifecycle (see `fact-check-state.ts` for the vocabulary):
 *
 *   idle ──tap──► working ──terminal row──► ready
 *                    │
 *                    ├──60s deadline──► timeout  ("still working" | "failed")
 *                    └──mutation threw─► error
 *
 * Two behaviours are load-bearing and easy to lose in a refactor:
 *
 * 1. The MUTATION'S OWN RETURN is treated as the first poll result. The server
 *    caches fact checks across users, so an article somebody else already
 *    checked comes back `complete` from `requestFactCheck` itself. Dropping
 *    into the poll loop regardless would add a pointless 3s wait to the
 *    commonest fast path.
 * 2. Progress is gated behind `PROGRESS_DELAY_MS`. Combined with (1), a cache
 *    hit renders tap → verdict with no spinner in between.
 *
 * `failed` is NOT treated as terminal mid-run — the server fails over between
 * models and bumps `attempts` — but it IS remembered, so a deadline reached
 * with `failed` as the last observation reports failure instead of telling the
 * reader to come back for an answer that is not coming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactCheck } from '../generated/graphql-types';
import logger from '../logger';
import { FactCheckService } from './fact-check-service';
import {
    isTerminalStatus,
    POLL_INTERVAL_MS,
    POLL_TIMEOUT_MS,
    PROGRESS_DELAY_MS,
    shouldShowProgress,
    timeoutCopyKey,
    type FactCheckPhase,
} from './fact-check-state';

export interface UseFactCheckResult {
    phase: FactCheckPhase;
    /** The completed (or blocked) row. Only meaningful when phase is 'ready'. */
    result: FactCheck | null;
    /** True only once the wait has been long enough to deserve a spinner. */
    showProgress: boolean;
    /** i18n key for the timeout message. Only set when phase is 'timeout'. */
    timeoutKey: string | null;
    /** Start (or re-start) a check. No-op while one is already running. */
    start: () => void;
    /** Cancel any in-flight run and collapse back to 'idle'. */
    dismiss: () => void;
}

export function useFactCheck(articleId: string | null | undefined): UseFactCheckResult {
    const [phase, setPhase] = useState<FactCheckPhase>('idle');
    const [result, setResult] = useState<FactCheck | null>(null);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [timeoutKey, setTimeoutKey] = useState<string | null>(null);

    // Monotonic run id: every settle/cancel path compares against it, so a
    // late-arriving response from an abandoned run (unmount, article change,
    // dismiss) can never write state.
    const runIdRef = useRef(0);
    const runningRef = useRef(false);
    const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Status is mirrored in a ref because the timeout branch reads it inside an
    // async continuation, where the state value would be a stale closure copy.
    const lastStatusRef = useRef<string | null>(null);

    const clearTimers = useCallback(() => {
        if (pollTimerRef.current) {
            clearTimeout(pollTimerRef.current);
            pollTimerRef.current = null;
        }
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
        setTimeoutKey(null);
        lastStatusRef.current = null;
    }, [articleId]);

    const start = useCallback(() => {
        if (!articleId || runningRef.current) return;
        runningRef.current = true;
        const run = ++runIdRef.current;
        const alive = () => runIdRef.current === run;
        clearTimers();

        setPhase('working');
        setResult(null);
        setTimeoutKey(null);
        setElapsedMs(0);
        lastStatusRef.current = null;
        const startedAt = Date.now();

        progressTimerRef.current = setTimeout(() => {
            if (alive()) setElapsedMs(PROGRESS_DELAY_MS);
        }, PROGRESS_DELAY_MS);

        const settle = (row: FactCheck) => {
            clearTimers();
            runningRef.current = false;
            setResult(row);
            setPhase('ready');
        };

        const giveUp = () => {
            clearTimers();
            runningRef.current = false;
            setTimeoutKey(timeoutCopyKey(lastStatusRef.current));
            setPhase('timeout');
        };

        const expired = () => Date.now() - startedAt >= POLL_TIMEOUT_MS;

        const scheduleNext = (poll: () => void) => {
            if (expired()) {
                giveUp();
                return;
            }
            pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        };

        const poll = () => {
            FactCheckService.getFactCheck(articleId)
                .then((row) => {
                    if (!alive()) return;
                    if (row) lastStatusRef.current = row.status;
                    if (row && isTerminalStatus(row.status)) {
                        settle(row);
                        return;
                    }
                    scheduleNext(poll);
                })
                .catch((err) => {
                    if (!alive()) return;
                    // A dropped poll is not a failed check — the row is still
                    // being written server-side. Keep trying until the deadline.
                    logger.captureException(err, {
                        tags: { hook: 'useFactCheck', method: 'getFactCheck' },
                        extra: { articleId },
                    });
                    scheduleNext(poll);
                });
        };

        FactCheckService.requestFactCheck(articleId)
            .then((row) => {
                if (!alive()) return;
                if (row) lastStatusRef.current = row.status;
                // The cross-user cache hit: already complete, render it now.
                if (row && isTerminalStatus(row.status)) {
                    settle(row);
                    return;
                }
                scheduleNext(poll);
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
    }, [articleId, clearTimers]);

    const dismiss = useCallback(() => {
        runIdRef.current += 1;
        runningRef.current = false;
        clearTimers();
        setPhase('idle');
        setResult(null);
        setElapsedMs(0);
        setTimeoutKey(null);
        lastStatusRef.current = null;
    }, [clearTimers]);

    return {
        phase,
        result,
        showProgress: shouldShowProgress(phase, elapsedMs),
        timeoutKey,
        start,
        dismiss,
    };
}
