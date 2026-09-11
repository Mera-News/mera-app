import * as Sentry from '@sentry/react-native';
import type { Job, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import logger, { classifySuppression } from '@/lib/logger';
import { isNonRetryableError } from '@/lib/utils/retry';

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
    // Clear the failure backoff: this task is healthy again, so the next tick
    // should judge it on frequency alone. Paired with recordFailure below, and
    // deliberately here rather than in AppScheduler._enqueueAndRun — run()
    // catches without rethrowing, so a clear placed there would fire on every
    // outcome, failures included, and the gate would never bite.
    {
      const { AppScheduler } = require('./AppScheduler') as typeof import('./AppScheduler');
      AppScheduler.clearFailure(definition.name);
    }
    useSchedulerStore.getState().setJobCompleted(job.id, now, !noOp);
    try { transaction?.setStatus?.('ok'); } catch { /* best-effort */ }

  } catch (err) {
    // A non-retryable error (e.g. a 4xx / BAD_USER_INPUT from the server) will
    // never succeed on a retry — rescheduling just re-runs the same doomed
    // request storm. Treat it as terminal: skip the maxAttempts reschedule.
    // Stamp the failure before anything else in this branch: the 5s tick reads
    // it to decide whether this task may run again, and a failed job does not
    // stamp `lastRun`, so without this the frequency gate stays open and the
    // tick re-fires the task every 5 seconds for as long as it keeps failing.
    {
      const { AppScheduler } = require('./AppScheduler') as typeof import('./AppScheduler');
      AppScheduler.recordFailure(definition.name);
    }

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

    // THE SUPPRESSION RULES REACH THIS PATH THROUGH THE SHARED CLASSIFIER.
    //
    // This is the one reporting path that cannot go through
    // logger.captureException: it calls Sentry DIRECTLY inside a withScope so
    // it can attach the `scheduler.*` tags. It used to re-implement the 401 and
    // cancellation checks by hand, which meant every class added at the choke
    // point silently missed it — a task that failed for a suppressed reason
    // re-formed the storm here wearing scheduler tags instead (Sentry
    // MERA-APP-3P/42/4V/64: 181 events in 30 days from two users, in bursts of
    // a dozen per cold start). It now asks the classifier for the same answer
    // logger would give, so a new class covers this path for free.
    //
    // The reschedule bookkeeping below is unaffected: a suppressed report is
    // still a failed job and still retries.
    const suppression = classifySuppression(
      err instanceof Error ? err : new Error(String(err)),
    );
    if (suppression !== null) {
      logger.addBreadcrumb(
        `[${definition.name}] ${suppression} — Sentry capture suppressed`,
        'scheduler',
        { jobId: job.id, attempt: job.attempt, exhausted, suppressed: suppression },
        suppression === 'auth' ? 'warning' : 'info',
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
      setTimeout(
        () =>
          AppScheduler.trigger(definition.name, undefined, {
            // A machine retry must not consume the debounce window that exists
            // to bound a human pull.
            bypassDebounce: true,
            // Carry the attempt forward, or this ladder never ends: createJob
            // used to mint every job at attempt 1, so `exhausted` above was
            // never true and the backoff repeated at 30s indefinitely.
            attempt: job.attempt + 1,
          }),
        retryDelay,
      );
    }

  } finally {
    clearTimeout(timeoutId);
    if (!transactionFinished) {
      try { transaction?.end?.(); } catch { /* best-effort */ }
      transactionFinished = true;
    }
  }
}
