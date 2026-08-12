import * as Sentry from '@sentry/react-native';
import type { Job, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import logger from '@/lib/logger';
import { isNonRetryableError, isUnauthenticatedError } from '@/lib/utils/retry';

function defaultBackoff(attempt: number): number {
  return ([30_000, 60_000, 120_000][attempt - 1] ?? 120_000);
}

export async function run(job: Job, definition: TaskDefinition): Promise<void> {
  const abortController = new AbortController();
  const timeoutMs = definition.timeout ?? 120_000;
  const timeoutId = setTimeout(() => abortController.abort('timeout'), timeoutMs);

  await persistence.markRunning(job.id);
  useSchedulerStore.getState().setJobRunning(job.id);

  let transactionFinished = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transaction: any;
  try {
    transaction = Sentry.startInactiveSpan({
      name: `task.${definition.name}`,
      op: 'app.task',
      attributes: { jobId: job.id, attempt: job.attempt },
    });
  } catch {
    transaction = null;
  }

  // Set via ctx.markNoOp() by a handler that returned without doing real work
  // (a guard that skipped the cycle, a mid-run abort). The job still counts as
  // completed, but `lastRun` is left alone: stamping it would arm the task's
  // frequency gate off a run that accomplished nothing, so the next tick /
  // foreground would skip too. That is how a single skipped feed-sync cycle
  // used to turn into a 60s dead zone repeated indefinitely.
  let noOp = false;

  try {
    await definition.handler(job.input as never, {
      jobId: job.id,
      attempt: job.attempt,
      signal: abortController.signal,
      reportProgress: (p) => useSchedulerStore.getState().updateProgress(job.id, p),
      log: (msg) => {
        logger.info(`[${definition.name}] ${msg}`);
        try { transaction?.setAttribute?.('last_log', msg); } catch { /* best-effort */ }
      },
      markNoOp: () => { noOp = true; },
    });

    const now = Date.now();
    await persistence.markCompleted(job.id, now);
    if (!noOp) await persistence.saveLastRun(definition.name, now);
    useSchedulerStore.getState().setJobCompleted(job.id, now, !noOp);
    try { transaction?.setStatus?.('ok'); } catch { /* best-effort */ }

  } catch (err) {
    // A non-retryable error (e.g. a 4xx / BAD_USER_INPUT from the server) will
    // never succeed on a retry — rescheduling just re-runs the same doomed
    // request storm. Treat it as terminal: skip the maxAttempts reschedule.
    const nonRetryable = isNonRetryableError(err);
    if (nonRetryable) {
      logger.addBreadcrumb(
        `[${definition.name}] non-retryable error — skipping reschedule`,
        'scheduler',
        { jobId: job.id, attempt: job.attempt },
        'warning',
      );
    }
    const exhausted = nonRetryable || job.attempt >= (definition.maxAttempts ?? 3);
    const retryDelay = definition.retryDelay?.(job.attempt) ?? defaultBackoff(job.attempt);
    const retryAt = exhausted ? undefined : Date.now() + retryDelay;

    await persistence.markFailed(job.id, err, exhausted, retryAt);
    useSchedulerStore.getState().setJobFailed(job.id, exhausted, retryAt);
    try { transaction?.setStatus?.('internal_error'); } catch { /* best-effort */ }

    // THE 401 RULE, THIRD AND LAST SITE. One dead session makes every
    // authenticated call in the app fail identically, so a per-failure Sentry
    // event buys hundreds of duplicates for a single root cause. The Apollo
    // error link (`lib/apollo-client.ts`) and `ArticleService.reportQueryError`
    // both already downgrade a 401 to a breadcrumb — but the rejection still
    // propagates out of the task, and THIS capture had no exemption, so the
    // storm simply re-formed here wearing `scheduler.*` tags instead. That is
    // Sentry MERA-APP-3P/42/4V/64: 181 events in 30 days from two users, in
    // bursts of a dozen per cold start. The auth breaker's single trip event is
    // the signal; the reschedule bookkeeping above is unaffected.
    if (isUnauthenticatedError(err)) {
      logger.addBreadcrumb(
        `[${definition.name}] UNAUTHENTICATED — Sentry capture suppressed`,
        'scheduler',
        { jobId: job.id, attempt: job.attempt, exhausted },
        'warning',
      );
    } else {
      Sentry.withScope((scope) => {
        scope.setTag('scheduler.task', definition.name);
        scope.setTag('scheduler.jobId', job.id);
        scope.setTag('scheduler.attempt', String(job.attempt));
        scope.setLevel(exhausted ? 'error' : 'warning');
        Sentry.captureException(err);
      });
    }

    if (retryAt) {
      const { AppScheduler } = require('./AppScheduler') as typeof import('./AppScheduler');
      setTimeout(() => AppScheduler.trigger(definition.name), retryDelay);
    }

  } finally {
    clearTimeout(timeoutId);
    if (!transactionFinished) {
      try { transaction?.end?.(); } catch { /* best-effort */ }
      transactionFinished = true;
    }
  }
}
