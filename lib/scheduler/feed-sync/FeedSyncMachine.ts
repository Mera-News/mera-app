import { useNetworkStore } from '@/lib/stores/network-store';
import logger from '@/lib/logger';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import {
  requestSuggestionsRefresh,
  flushSuggestionsRefresh,
} from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { ArticleService } from '@/lib/article-service';
import { toastManager } from '@/lib/toast-manager';
import type { TaskContext } from '../scheduler-types';
import * as feedPersistence from './feed-sync-persistence';
import * as steps from './feed-sync-steps';
import { classifyError, publishSyncError, publishSyncStatus } from './feed-sync-status';
import type { FeedSyncState } from './feed-sync-types';
import { InvalidTransitionError, NETWORK_DEPENDENT_STATES } from './feed-sync-types';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'mera-feed-sync';

/**
 * Kill-switch for the "fetch while the scoring pipeline is running" behaviour.
 *
 * A running pipeline used to skip the WHOLE cycle — fetch, diff, hydrate and
 * score — for up to STALE_RUN_GUARD_MS at a time, which is the dominant cause
 * of a user staring at an empty feed. Only SCORE actually needs skipping (the
 * original concern was appending fresh batches to a live run and never letting
 * it finish). With this true we fetch + hydrate normally, leave the new rows
 * `Unscored`, and let `runPostFinalizeKick` pick them up when the live run
 * finalizes.
 *
 * Flip to false to restore the old early-return exactly — this is the riskiest
 * change in the wave, and it is a named export so a hotfix OTA can disable it
 * without touching any other logic.
 */
export const FETCH_WHILE_SCORING = true;

/** A run whose promise hasn't settled in this long is presumed dead — the
 *  scheduler aborts the task at 3 min, so anything past 4 min means the run was
 *  frozen (backgrounded) rather than slow. Joining such a promise would block
 *  every future sync for the rest of the session. */
export const INFLIGHT_STALE_MS = 4 * 60 * 1000;

/** Epoch ms of the next 00:00 UTC — fallback reset time for the daily cap when
 *  the server response didn't carry one. */
function nextUtcMidnightMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
}

/** Today's date as `YYYY-MM-DD` (UTC) — gates the daily-limit notice (toast +
 *  notification-center row) to once per UTC day via the persisted
 *  `dailyLimitNoticeDay` marker on for-you-store. A new UTC day naturally
 *  re-arms it since the stored value no longer matches. */
function todayUtcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

const VALID_TRANSITIONS: Partial<Record<FeedSyncState, FeedSyncState[]>> = {
  idle:                 ['fetching-topic-ids'],
  'fetching-topic-ids': ['diffing', 'paused-offline', 'failed'],
  diffing:              ['hydrating', 'scoring', 'done', 'failed'],
  // hydrate/persist/enqueue are merged into `hydrating`, which flows straight to
  // `scoring` (the old `persisting` state is gone).
  hydrating:            ['scoring', 'paused-offline', 'failed'],
  scoring:              ['done', 'failed'],
  // A pause during `hydrating` leaves _state at `paused-offline`; on resume the
  // merged step finishes and the machine transitions to `scoring` from here.
  'paused-offline':     ['fetching-topic-ids', 'diffing', 'scoring', 'failed'],
  failed:               ['idle'],
  done:                 ['idle'],
};

class FeedSyncMachine {
  private _state: FeedSyncState = 'idle';
  private _networkUnsubscribe: (() => void) | null = null;
  private _paused = false;
  /**
   * Everyone currently parked in `_awaitResumeIfPaused`, resolved together.
   *
   * A SET, NOT A SINGLE SLOT, because hydrate runs a pool: `HYDRATE_CONCURRENCY`
   * is 3 and every worker calls `awaitResumeIfPaused()` at the top of its loop.
   * With one slot each parking worker overwrote the previous one's resolver, so
   * on reconnect only the last was ever resolved — the other two never settled,
   * their `Promise.all` never resolved, and the run hung for the rest of the
   * session. That hang is what made a run go stale and get abandoned, which is
   * what produced the transition collisions in the first place.
   *
   * Releasing the displaced resolver instead would be worse than the bug: the
   * first worker would un-park while the device is still offline and go
   * straight back to fetching. Same-run waiters have to resume together.
   */
  private _resumeWaiters = new Set<() => void>();
  /** Non-null while a run is in flight. The machine is a module singleton with a
   *  single mutable `_state`, so two concurrent runs would stomp each other's
   *  transitions (the "Invalid FeedSyncMachine transition" errors). This makes
   *  non-reentrancy an invariant of the machine itself, independent of the
   *  scheduler's exclusivity guard. */
  private _inFlight: Promise<void> | null = null;
  /** Wall-clock start of `_inFlight`, so a promise that will never settle can
   *  be recognised and abandoned rather than joined. */
  private _inFlightStartedAt = 0;
  /** Monotonic run id. The `_start` teardown touches instance fields
   *  (keep-awake tag, network subscription); if an abandoned run settles late
   *  it must not tear down the run that replaced it. */
  private _runSeq = 0;
  /**
   * Whether THIS machine currently holds the `expo-keep-awake` tag.
   *
   * The lock is taken and released at several points in a run (fetch/hydrate
   * start, every `paused-offline` wait, and again before scoring hands off), so
   * the release path is reachable more than once per run. `deactivateKeepAwake`
   * on a tag that is not held is not a no-op worth relying on, so the flag makes
   * release idempotent rather than assuming the call sites are mutually
   * exclusive.
   */
  private _keepAwakeHeld = false;

  get state(): FeedSyncState {
    return this._state;
  }

  isRunning(): boolean {
    return (
      this._state !== 'idle' &&
      this._state !== 'done' &&
      this._state !== 'failed'
    );
  }

  async start(personaId: string, ctx: TaskContext): Promise<void> {
    // Re-entrancy guard. If a run is already in flight, join it rather than
    // starting a second run that would reset `_state` to 'idle' mid-flight and
    // race the existing run's transitions. Covers the scheduler's
    // check-then-run async gap and the retry path that bypasses the exclusivity
    // guard (AppScheduler.trigger).
    if (this._inFlight) {
      const age = Date.now() - this._inFlightStartedAt;
      if (age <= INFLIGHT_STALE_MS) {
        logger.debug('[FeedSyncMachine] start() called while a run is in flight — joining existing run');
        return this._inFlight;
      }
      // The previous run's promise is never going to settle (the JS timer that
      // would have aborted it was frozen while the app was backgrounded).
      // Joining it would wedge feed-sync for the rest of the session — drop the
      // reference and start fresh instead.
      logger.warn(
        `[FeedSyncMachine] abandoning a stale in-flight run (${Math.round(age / 60_000)}min) — starting fresh`,
      );
      // Let the abandoned run UNWIND rather than stay parked. This is what makes
      // "abandon it but let it finish" actually terminate: a run parked in
      // `_awaitResumeIfPaused` can only be woken by the live run's network
      // listener, which will now ignore it, so without this it never settles.
      // Its transitions are already inert, so waking it is harmless.
      this._releaseResumeWaiters();
      this._inFlight = null;
    }
    this._inFlightStartedAt = Date.now();
    // Identity guard: only the run that OWNS the current `_inFlight` slot may
    // clear it. Without this, an abandoned run settling later would null out
    // the reference to the live run and reopen the re-entrancy window.
    const thisRun: Promise<void> = this._start(personaId, ctx).finally(() => {
      if (this._inFlight === thisRun) this._inFlight = null;
    });
    this._inFlight = thisRun;
    return thisRun;
  }

  private async _start(personaId: string, ctx: TaskContext): Promise<void> {
    const runId = ++this._runSeq;
    const snap = await feedPersistence.loadValidSnapshot();
    if (snap && snap.state !== 'idle' && snap.state !== 'done' && snap.state !== 'failed') {
      logger.info(`[FeedSyncMachine] resuming from persisted state: ${snap.state}`);
    }

    await feedPersistence.saveMachineSnapshot({ state: 'idle', startedAt: Date.now() });
    this._forceIdle(runId); // bypasses the transition guard — valid from any state
    // `_paused` is per-run bookkeeping living on a singleton, and nothing used
    // to reset it. A run that died while paused left it `true`, so the NEXT run
    // parked at the first `_awaitResumeIfPaused` below waiting for a resume that
    // could never come: the listener's resume branch requires
    // `_state === 'paused-offline'`, and the line above just set it to `idle`.
    // On a stable connection no network event ever fires, so that run hung
    // forever — the second way a run went stale and got abandoned.
    // Deliberately NOT folded into `_forceIdle`: the catch-block callers of that
    // helper must not clear a pause the live run legitimately owns.
    if (this._isCurrentRun(runId)) this._paused = false;

    // WHOEVER SUBSCRIBES LAST RELEASES THE ONE IT FINDS. `_networkUnsubscribe`
    // is a single field, and the teardown at the bottom of this method is
    // ownership-guarded — so an ABANDONED run's handle was overwritten here
    // without ever being called, leaving its listener registered for the rest of
    // the session. One permanent leak per abandonment, each still mutating this
    // singleton. Safe against a double-unsubscribe: `_runSeq` was bumped above,
    // so the previous run's teardown will not touch the field.
    this._networkUnsubscribe?.();
    this._networkUnsubscribe = null;

    this._networkUnsubscribe = useNetworkStore.subscribe((state, prev) => {
      // Inert once this run no longer owns the machine — and inert ENTIRELY,
      // not just for the transition. The two branches below also write
      // `_paused` and fire the resume waiters, neither of which routes through
      // `_transitionTo`, so its guard cannot cover them. A stale listener could
      // otherwise un-park the LIVE run mid-wait.
      if (!this._isCurrentRun(runId)) return;
      const networkState = this._state;
      if (!state.isConnected && NETWORK_DEPENDENT_STATES.includes(networkState)) {
        const pausedAtState = networkState;
        this._transitionTo('paused-offline', runId);
        this._paused = true;
        publishSyncStatus('paused-offline', { pausedAtState });
      } else if (state.isConnected && !prev.isConnected && this._state === 'paused-offline') {
        this._paused = false;
        this._releaseResumeWaiters();
      }
    });

    await this._acquireKeepAwake(runId);
    try {
      await this._run(personaId, ctx, runId);
    } finally {
      // Terminal exactness across EVERY exit path (completion, mid-run abort
      // return, error throw): flush any pending coalesced refresh so the store
      // reflects the final DB state before teardown.
      await flushSuggestionsRefresh();
      // Only the newest run owns the shared resources below. An abandoned run
      // (see the INFLIGHT_STALE_MS branch in start()) can settle long after a
      // replacement started; releasing the keep-awake tag and the network
      // subscription then would silently maim the live run.
      if (this._runSeq === runId) {
        // Idempotent: on the happy path `_run` already handed the lock off
        // before scoring. This is the catch-all for the paths that never got
        // there — an early abort, or a throw during fetch/hydrate.
        this._releaseKeepAwake(runId);
        this._networkUnsubscribe?.();
        this._networkUnsubscribe = null;
      }
    }
  }

  /**
   * Take the wake lock for `runId`, once.
   *
   * Guarded by run identity for the same reason the teardown in `_start` is: an
   * abandoned run (see the `INFLIGHT_STALE_MS` branch in `start()`) must not
   * re-arm a lock the live run has deliberately dropped.
   */
  private async _acquireKeepAwake(runId: number): Promise<void> {
    if (this._runSeq !== runId) return;
    if (this._keepAwakeHeld) return;
    this._keepAwakeHeld = true;
    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  }

  /** Drop the wake lock. Safe to call when it is not held, and a no-op for any
   *  run that is no longer the newest — the same identity guard `_start`'s
   *  teardown uses, repeated here because this is now reachable mid-run. */
  private _releaseKeepAwake(runId: number): void {
    if (this._runSeq !== runId) return;
    if (!this._keepAwakeHeld) return;
    this._keepAwakeHeld = false;
    deactivateKeepAwake(KEEP_AWAKE_TAG);
  }

  private async _run(personaId: string, ctx: TaskContext, runId: number): Promise<void> {
    logger.debug('[FeedSyncMachine] run start');
    coldstartTimeline.mark('feed-sync-start');
    // Clear any prior scoring-pipeline error at the start of a fresh cycle — the
    // header status reflects this cycle's outcome. It re-appears if scoring fails
    // again, and resolves on its own if scoring succeeds.
    useForYouStore.getState().setScoringError(null);
    // Set when a scoring run is already in flight: this cycle fetches and
    // hydrates as usual but does NOT dispatch anything to the pipeline.
    let suppressScoring = false;
    try {
      // A scoring run already in flight constrains this cycle. Backend ingestion
      // is continuous (20-25 new articles at a time); dispatching every 60s
      // would keep appending fresh batches to the active run so it never
      // finishes. But that only rules out SCORING — fetching and hydrating are
      // harmless, and skipping them (as this used to) starves the feed for as
      // long as the run lives. So we fetch + hydrate, leave the new rows
      // `Unscored`, and let the pipeline's own `runPostFinalizeKick` re-derive
      // and enqueue them when it finalizes.
      //
      // Lazy require (not a static import) breaks the module-load cycle
      // feed-sync-steps → scoring-pipeline → SuggestionSyncService → run-inference-
      // handler → feed-sync-steps. Same pattern as lib/database/hydrate-stores.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const scoringPipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
      const pipelineStatus = await scoringPipeline.getPipelineStatus();
      if (pipelineStatus === 'running') {
        // Defense in depth against a wedged run (a batch stuck waiting-* on a
        // throwing /results, or a run orphaned by a cache-clear): if the run has
        // been alive longer than STALE_RUN_GUARD_MS it cannot be trusted to
        // finish on its own, and even the suppressed path below would never
        // score again. Abort it (force-fail + finalize) and sync in full.
        const startedAt = await scoringPipeline.getRunStartedAt();
        const ageMs = startedAt !== null ? Date.now() - startedAt : 0;
        if (startedAt !== null && ageMs > scoringPipeline.STALE_RUN_GUARD_MS) {
          logger.warn(
            `[FeedSyncMachine] scoring pipeline running but run is stale (${Math.round(ageMs / 60_000)}min) — aborting and proceeding`,
          );
          await scoringPipeline.abortRun('stale-guard');
        } else if (FETCH_WHILE_SCORING) {
          suppressScoring = true;
          logger.debug('[FeedSyncMachine] scoring pipeline active — fetching without scoring');
        } else {
          // Legacy behaviour, kept behind the kill-switch: bail out with the
          // machine untouched (still `idle` — no transitions, no persisted
          // state, no server calls).
          logger.debug('[FeedSyncMachine] skipped — scoring pipeline active');
          ctx.markNoOp();
          return;
        }
      }

      // Step 1: fetch topic IDs. NOTE (Round-4 B): the fetching-topic-ids and
      // diffing statuses are NOT published — a bare poll that finds no new
      // articles must be silent (no shimmer flicker). Only the has-work path
      // publishes, from `hydrating` onward. Internal `_transitionTo` +
      // `updateMachineState` bookkeeping still runs so the machine + persisted
      // snapshot stay consistent.
      this._transitionTo('fetching-topic-ids', runId);
      logger.debug('[FeedSyncMachine] → fetching-topic-ids');
      await feedPersistence.updateMachineState('fetching-topic-ids');

      await this._awaitResumeIfPaused(runId);
      if (ctx.signal.aborted) { ctx.markNoOp(); return; }

      const [topicResult, recentCount] = await Promise.all([
        steps.stepFetchTopicIds(personaId, ctx),
        ArticleService.getRecentArticleCount().catch((err) => {
          logger.captureException(err, { tags: { service: 'FeedSyncMachine', method: 'getRecentArticleCount' } });
          return 0;
        }),
      ]);
      coldstartTimeline.mark(
        'topic-ids-resolved',
        `ids=${topicResult.serverArticleIds.length}`,
      );
      // Record the server-wide 24h article count now so subsequent
      // refreshSuggestionsInStore calls (which only know about on-device rows)
      // don't overwrite it. Falls back to the topic-matched count if the query failed.
      useForYouStore.getState().setCounts(
        recentCount || topicResult.serverArticleIds.length,
        useForYouStore.getState().relevantArticleCount,
      );

      // Step 2: diff (status intentionally not published — see Step 1 note).
      this._transitionTo('diffing', runId);
      logger.debug('[FeedSyncMachine] → diffing');
      await feedPersistence.updateMachineState('diffing');

      if (ctx.signal.aborted) { ctx.markNoOp(); return; }
      const diffResult = await steps.stepDiff(topicResult, ctx);

      if (diffResult.missingIds.length === 0) {
        // No new articles and nothing deleted — but still run scoring in case
        // articles from a prior run are waiting to be analysed (e.g. when the
        // previous scoring step failed transiently and left unscoredCount > 0).
        //
        // Round-4 B: this no-op cycle is SILENT — no transient scoring/done/idle
        // publishes and no 2s done→idle timer, so a bare poll never flickers the
        // shimmer. Internal transitions + snapshot clearing + setLastSyncAt still
        // run so the machine stays consistent. If scoring actually finds work,
        // the scoring-pipeline publishes its own header progress independently.
        this._transitionTo('scoring', runId);
        logger.debug('[FeedSyncMachine] → scoring (no new articles, silent)');
        await feedPersistence.updateMachineState('scoring');

        if (ctx.signal.aborted) { ctx.markNoOp(); return; }
        // Fetch/hydrate is over; scoring owns its own wake lock (the on-device
        // path takes one in SuggestionSyncService, and the cloud path needs
        // none). See `_releaseKeepAwake`.
        this._releaseKeepAwake(runId);
        // Suppressed: a live scoring run already owns the unscored backlog and
        // will re-derive it on finalize. Everything else about this branch is
        // bookkeeping, so we still walk it to `done`.
        if (!suppressScoring) await steps.stepScore(ctx);

        await flushSuggestionsRefresh();
        this._transitionTo('done', runId);
        useForYouStore.getState().setLastSyncAt(Date.now());
        // A cycle that found nothing to do is still a processing run that
        // FINISHED, and it has to say so. `lastProcessingRunFinishedAt` is what
        // both feed surfaces read to choose between FeedPreparingCard and
        // AllCaughtUpCard, and on this path nothing else can ever stamp it: no
        // rows are enqueued, so no pipeline run exists, so `doFinalize` — the
        // usual stamper — bails before reaching it. Without this, a window that
        // legitimately holds no articles leaves "Mera is preparing your feed."
        // on screen forever. Same remedy `abortRun` already applies for the same
        // stated reason (scoring-pipeline.ts, `abortRun`).
        //
        // Skipped while suppressed: a live scoring run owns the unscored backlog
        // and will stamp its own finalize, so claiming "finished" here would
        // resolve the card while work is genuinely still in flight.
        if (!suppressScoring) {
          useForYouStore.getState().markProcessingRunFinished();
        }
        try {
          await feedPersistence.clearMachineSnapshot();
        } catch (snapErr) {
          logger.captureException(snapErr, {
            tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
          });
        }
        return;
      }

      // Step 3: hydrate + persist + enqueue (merged, batched, pipelined)
      this._transitionTo('hydrating', runId);
      publishSyncStatus('hydrating');
      await feedPersistence.updateMachineState('hydrating');

      await this._awaitResumeIfPaused(runId);
      if (ctx.signal.aborted) { ctx.markNoOp(); return; }

      const total = diffResult.missingIds.length;
      const hydrateResult = await steps.stepHydratePersistEnqueue(diffResult, ctx, {
        onProgress: (completed) => {
          ctx.reportProgress({ step: 'hydrating', current: completed, total });
          publishSyncStatus('hydrating', { progress: { current: completed, total } });
        },
        awaitResumeIfPaused: () => this._awaitResumeIfPaused(runId),
        // A1: coalesce the per-chunk store refreshes into a leading+trailing
        // throttle instead of a full reload after every 25-item chunk.
        refreshStore: () => requestSuggestionsRefresh(),
        // Hydrate, propagate scores from donors, but don't hand anything to the
        // live pipeline run — rows stay `Unscored` for its post-finalize kick.
        suppressEnqueue: suppressScoring,
      });
      useForYouStore.getState().resetHydrationProgress();

      // Daily cap banner: if this run was partially clipped, surface the "limit
      // reached" notice now (we still delivered what fit) rather than waiting for
      // the next fully-blocked cycle. A fully-unclipped delivery means we're
      // under the cap — clear it.
      useForYouStore.getState().setDailyLimitResetAt(
        hydrateResult.dailyLimitReached
          ? hydrateResult.resetAt
            ? Date.parse(hydrateResult.resetAt)
            : nextUtcMidnightMs()
          : null,
      );
      // Final refresh after all chunks (each chunk already requested a
      // throttled refresh) — flush guarantees the last chunk landed exactly.
      await flushSuggestionsRefresh();

      // Step 4: score
      this._transitionTo('scoring', runId);
      publishSyncStatus('scoring');
      await feedPersistence.updateMachineState('scoring');

      if (ctx.signal.aborted) { ctx.markNoOp(); return; }
      // Fetch/hydrate is over — hand the lock off (see the no-op branch above).
      this._releaseKeepAwake(runId);
      // See the no-op branch above: the `scoring` transition and its published
      // status still happen (hydrating → done is not a legal transition), only
      // the dispatch is suppressed.
      if (!suppressScoring) await steps.stepScore(ctx);

      // Done
      await flushSuggestionsRefresh();
      this._transitionTo('done', runId);
      publishSyncStatus('done');
      useForYouStore.getState().setLastSyncAt(Date.now());
      try {
        await feedPersistence.clearMachineSnapshot();
      } catch (snapErr) {
        logger.captureException(snapErr, {
          tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
        });
      }

      // Auto-reset to idle after 2s so the UI can show "done" briefly.
      //
      // The whole body is run-guarded, not just the transition: this timer is
      // never cleared, so a run that finishes and is replaced inside 2s would
      // otherwise fire under its replacement and — if that replacement is
      // legitimately at `done` — reset it early AND call publishSyncStatus('idle'),
      // which blanks the live header's status message.
      setTimeout(() => {
        if (!this._isCurrentRun(runId)) return;
        if (this._state === 'done') {
          this._transitionTo('idle', runId);
          publishSyncStatus('idle');
        }
      }, 2_000);

    } catch (err) {
      const errorCode = classifyError(err);

      // `not-subscribed` is Mera News Free, not a fault. The user has no plan,
      // the four AI queries 402, and that is the designed outcome — so this
      // exits the quietest way the machine can: straight to idle, no status
      // message at all (publishSyncStatus('idle') CLEARS it), no error chrome,
      // no toast, and no throw, so the scheduler marks the job complete and
      // does not schedule its 3× retry. `recordAiLocked` has already flipped
      // aiAccess, which is what stops the task firing again at all; this branch
      // handles the run already in flight when the verdict landed.
      if (errorCode === 'not-subscribed') {
        this._forceIdle(runId); // bypasses the transition guard — valid from any state
        publishSyncStatus('idle');
        try {
          await feedPersistence.clearMachineSnapshot();
        } catch (snapErr) {
          logger.captureException(snapErr, {
            tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
          });
        }
        return;
      }

      // `no-topics-configured` is the normal state for a user who hasn't
      // generated interests yet — not a failure. Treat it as a clean, terminal
      // "no work" outcome: show the add-interests prompt, reset to idle, and
      // return WITHOUT throwing so the scheduler marks the job completed (no
      // 3× retry, no Sentry error). Recovery is the user adding interests.
      if (errorCode === 'no-topics-configured') {
        publishSyncError('no-topics-configured', undefined, this._state);
        this._forceIdle(runId); // bypasses the transition guard — valid from any state
        try {
          await feedPersistence.clearMachineSnapshot();
        } catch (snapErr) {
          logger.captureException(snapErr, {
            tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
          });
        }
        return;
      }

      // `daily-limit` is a normal terminal "no more today" outcome (the user
      // hit their daily article-delivery cap), not a failure. Surface the
      // "resumes at X" notice (retryAt = server resetAt), reset to idle, and
      // return WITHOUT throwing — no retry, no Sentry error.
      if (errorCode === 'daily-limit') {
        const resetAt = (err as { resetAt?: number }).resetAt;
        const store = useForYouStore.getState();
        // Sticky banner state: persists across the transient fetch/diff
        // statuses each polling cycle publishes, so the "limit reached" notice
        // stays visible until a sync delivers articles again or the reset
        // passes. Fall back to the next UTC midnight if the server omitted it.
        store.setDailyLimitResetAt(resetAt ?? nextUtcMidnightMs());
        publishSyncError('daily-limit', resetAt, this._state);

        // Gate the repeating toast/notification-center row to once per UTC
        // day. Without this, the 60s task-gate re-arm and the 5s
        // foreground-gap check (AppScheduler) both hit this branch again on
        // every subsequent cycle, firing a fresh notice every time until
        // 00:00 UTC — the reported "daily limit keeps popping" bug.
        // `dailyLimitNoticeDay` is persisted (unlike `dailyLimitResetAt`), so
        // this also survives an app restart within the same UTC day.
        const today = todayUtcDateString();
        if (store.dailyLimitNoticeDay !== today) {
          void toastManager.showNotifiedToast({
            type: 'feed_info',
            source: 'feed-sync',
            title: 'notificationCenter.dailyLimitTitle',
            body: 'notificationCenter.dailyLimitBody',
            action: 'info',
            icon: 'hourglass-empty',
            // Belt-and-braces: the dailyLimitNoticeDay check above already
            // gates this whole call to once/UTC-day, but this call site is
            // genuinely repeat-prone (60s scheduler re-arm), so opt the
            // persisted row into notify()'s same-day dedupe too.
            dedupeDaily: true,
          });
          store.setDailyLimitNoticeDay(today);
        }
        this._forceIdle(runId); // bypasses the transition guard — valid from any state
        try {
          await feedPersistence.clearMachineSnapshot();
        } catch (snapErr) {
          logger.captureException(snapErr, {
            tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
          });
        }
        return;
      }

      const failedAtState = this._state; // capture before transition
      // OWNERSHIP FIRST, and it matters more here than the transition guard
      // does. When an abandoned run threw while the live run was mid-cycle,
      // `hydrating → failed` was a LEGAL pair — so the zombie quietly drove the
      // singleton to `failed`, published the error, fired the sync-failed toast
      // and persisted a `failed` snapshot, all over a healthy sync. That is a
      // worse outcome than the InvalidTransitionError it sometimes threw
      // instead. `throw err` stays outside: the zombie's own job must still
      // fail and report.
      if (this._isCurrentRun(runId) && this._state !== 'failed' && this._state !== 'done') {
        this._transitionTo('failed', runId);
        publishSyncError(errorCode, undefined, failedAtState);
        // Generic (non-terminal, non-daily-limit) sync failure — surface a
        // notification-center-backed toast. The `no-topics-configured` and
        // `daily-limit` outcomes returned earlier, so this only fires for real
        // failures.
        void toastManager.showNotifiedToast({
          type: 'sync_event',
          source: 'feed-sync',
          title: 'notificationCenter.syncFailedTitle',
          body: 'notificationCenter.syncFailedBody',
          action: 'error',
          icon: 'sync-problem',
          // Unlike daily-limit, this branch has no persisted once-per-day
          // marker of its own — a repeated sync failure on the 60s
          // scheduler re-arm hits this every cycle. Opt the persisted row
          // into notify()'s same-day dedupe so the notification centre
          // doesn't fill with duplicate rows (the toast itself is unaffected).
          dedupeDaily: true,
        });
        await feedPersistence.saveMachineSnapshot({
          state: 'failed',
          startedAt: Date.now(),
          errorCode,
        });
      }
      throw err;
    }
  }

  /**
   * Move the machine to `next`, but only on behalf of the run that still owns it.
   *
   * `runId` IS REQUIRED, and that is deliberate: it makes `tsc` the completeness
   * check for call-site coverage rather than a comment nobody updates.
   *
   * THE GUARD IS THE FIX FOR Sentry MERA-APP-5W/6D/6E/61. `start()` abandons an
   * `_inFlight` run older than `INFLIGHT_STALE_MS` by dropping the reference —
   * it does not stop the run, which keeps executing against this singleton's one
   * `_state`. Its transitions are therefore evaluated against the REPLACEMENT's
   * state, and a pair that was perfectly legal for its own run ("→ diffing"
   * after fetch) reads as nonsense ("done → diffing") and throws. Two prod
   * events 32ms apart, from two jobs created 5m12s apart, are the evidence.
   *
   * A dropped transition is a breadcrumb, NOT a `logger.debug`: debug only emits
   * under `__DEV__`, and this guard firing in production — while those four
   * issues stay at zero — is the signal that says the fix is working.
   *
   * A genuine invalid transition in the LIVE run still throws, by design. The
   * collision was the only known cause, so anything left is a real bug and has
   * to stay loud.
   */
  private _transitionTo(next: FeedSyncState, runId: number): void {
    if (!this._isCurrentRun(runId)) {
      logger.addBreadcrumb(
        `[FeedSyncMachine] dropped transition from abandoned run: ${this._state} → ${next}`,
        'feed-sync',
        { runId, currentRun: this._runSeq },
        'info',
      );
      return;
    }
    const allowed = VALID_TRANSITIONS[this._state];
    if (allowed && !allowed.includes(next)) {
      throw new InvalidTransitionError(this._state, next);
    }
    this._state = next;
  }

  /**
   * True while `runId` still owns the machine.
   *
   * The one predicate behind every shared-state write, so "which run may touch
   * `_state`" has a single definition rather than a scattering of
   * `this._runSeq === runId` comparisons that can drift apart.
   */
  private _isCurrentRun(runId: number): boolean {
    return this._runSeq === runId;
  }

  /**
   * Force the machine back to `idle`, bypassing the transition table — legal
   * from any state — but only for the run that still owns it.
   *
   * THE OWNERSHIP CHECK IS NOT DEFENSIVE, IT IS THE OTHER HALF OF THE BUG.
   * These force-resets sit on terminal branches an ABANDONED run can still
   * reach. Zombie A rejecting with `daily-limit` used to set `_state = 'idle'`
   * while live run B sat at `hydrating`; B's next perfectly legal
   * `hydrating → scoring` was then evaluated as `idle → scoring` and threw —
   * from B, which owns the current `runId`. A guard on `_transitionTo` alone
   * passes that throw straight through, which is why both are needed.
   */
  private _forceIdle(runId: number): void {
    if (!this._isCurrentRun(runId)) return;
    this._state = 'idle';
  }

  /**
   * Block until the network comes back, holding NO wake lock while we wait.
   *
   * `paused-offline` is entered from the network subscription and is released
   * only by the device regaining connectivity — it can last minutes, a flight,
   * or the rest of the day. The lock used to span it because it was taken once
   * in `_start` and dropped once in that method's `finally`, so a device that
   * went offline mid-sync simply never dimmed. With feed-sync re-arming every
   * 60s that is close to a permanent "never sleep".
   *
   * Waiting is not work, so nothing is lost by dropping the lock here and
   * re-taking it on resume — the fetch/hydrate that follows is what actually
   * needs the screen kept alive.
   */
  private async _awaitResumeIfPaused(runId: number): Promise<void> {
    // An abandoned run must never park. Only the LIVE run's listener can
    // release waiters (see the ownership check in the subscription), so parking
    // here would strand this run for the rest of the session — the one zombie
    // that never finishes, holding an async frame and never reaching its
    // `flushSuggestionsRefresh`.
    if (!this._isCurrentRun(runId)) return;
    if (!this._paused) return;
    this._releaseKeepAwake(runId);
    await new Promise<void>((resolve) => {
      this._resumeWaiters.add(resolve);
    });
    // Abandoned while parked: do not re-arm a lock the live run has dropped.
    if (!this._isCurrentRun(runId)) return;
    await this._acquireKeepAwake(runId);
  }

  /**
   * Wake everyone parked in `_awaitResumeIfPaused`.
   *
   * Drained before resolving, so a waiter that immediately re-parks lands in a
   * fresh set rather than one being iterated.
   */
  private _releaseResumeWaiters(): void {
    if (this._resumeWaiters.size === 0) return;
    const waiters = [...this._resumeWaiters];
    this._resumeWaiters.clear();
    waiters.forEach((resolve) => resolve());
  }
}

export const feedSyncMachine = new FeedSyncMachine();
