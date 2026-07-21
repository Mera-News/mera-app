import { useNetworkStore } from '@/lib/stores/network-store';
import logger from '@/lib/logger';
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
  private _resumeCallback: (() => void) | null = null;
  /** Non-null while a run is in flight. The machine is a module singleton with a
   *  single mutable `_state`, so two concurrent runs would stomp each other's
   *  transitions (the "Invalid FeedSyncMachine transition" errors). This makes
   *  non-reentrancy an invariant of the machine itself, independent of the
   *  scheduler's exclusivity guard. */
  private _inFlight: Promise<void> | null = null;

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
      logger.info('[FeedSyncMachine] start() called while a run is in flight — joining existing run');
      return this._inFlight;
    }
    this._inFlight = this._start(personaId, ctx).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  private async _start(personaId: string, ctx: TaskContext): Promise<void> {
    const snap = await feedPersistence.loadValidSnapshot();
    if (snap && snap.state !== 'idle' && snap.state !== 'done' && snap.state !== 'failed') {
      logger.info(`[FeedSyncMachine] resuming from persisted state: ${snap.state}`);
    }

    await feedPersistence.saveMachineSnapshot({ state: 'idle', startedAt: Date.now() });
    this._state = 'idle'; // force reset — bypasses transition guard, valid from any state

    this._networkUnsubscribe = useNetworkStore.subscribe((state, prev) => {
      const networkState = this._state;
      if (!state.isConnected && NETWORK_DEPENDENT_STATES.includes(networkState)) {
        const pausedAtState = networkState;
        this._transitionTo('paused-offline');
        this._paused = true;
        publishSyncStatus('paused-offline', { pausedAtState });
      } else if (state.isConnected && !prev.isConnected && this._state === 'paused-offline') {
        this._paused = false;
        this._resumeCallback?.();
      }
    });

    await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    try {
      await this._run(personaId, ctx);
    } finally {
      // Terminal exactness across EVERY exit path (completion, mid-run abort
      // return, error throw): flush any pending coalesced refresh so the store
      // reflects the final DB state before teardown.
      await flushSuggestionsRefresh();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
      this._networkUnsubscribe?.();
      this._networkUnsubscribe = null;
    }
  }

  private async _run(personaId: string, ctx: TaskContext): Promise<void> {
    logger.info('[FeedSyncMachine] run start');
    // Clear any prior scoring-pipeline error at the start of a fresh cycle — the
    // header status reflects this cycle's outcome. It re-appears if scoring fails
    // again, and resolves on its own if scoring succeeds.
    useForYouStore.getState().setScoringError(null);
    try {
      // Skip this cycle entirely when a scoring run is already in flight.
      // Backend ingestion is continuous (20-25 new articles at a time); polling
      // every 10s would keep appending fresh batches to the active run so it
      // never finishes. Bail out here with the machine untouched (still
      // `idle` — no transitions, no persisted state, no server calls). The
      // pipeline self-drives via its internal poller; when it finalizes, the
      // next 10s tick finds it idle and polls normally.
      //
      // Lazy require (not a static import) breaks the module-load cycle
      // feed-sync-steps → scoring-pipeline → SuggestionSyncService → run-inference-
      // handler → feed-sync-steps. Same pattern as lib/database/hydrate-stores.ts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const scoringPipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
      const pipelineStatus = await scoringPipeline.getPipelineStatus();
      if (pipelineStatus === 'running') {
        logger.info('[FeedSyncMachine] skipped — scoring pipeline active');
        return;
      }

      // Step 1: fetch topic IDs. NOTE (Round-4 B): the fetching-topic-ids and
      // diffing statuses are NOT published — a bare poll that finds no new
      // articles must be silent (no shimmer flicker). Only the has-work path
      // publishes, from `hydrating` onward. Internal `_transitionTo` +
      // `updateMachineState` bookkeeping still runs so the machine + persisted
      // snapshot stay consistent.
      this._transitionTo('fetching-topic-ids');
      logger.info('[FeedSyncMachine] → fetching-topic-ids');
      await feedPersistence.updateMachineState('fetching-topic-ids');

      await this._awaitResumeIfPaused();
      if (ctx.signal.aborted) return;

      const [topicResult, recentCount] = await Promise.all([
        steps.stepFetchTopicIds(personaId, ctx),
        ArticleService.getRecentArticleCount().catch((err) => {
          logger.captureException(err, { tags: { service: 'FeedSyncMachine', method: 'getRecentArticleCount' } });
          return 0;
        }),
      ]);
      // Record the server-wide 24h article count now so subsequent
      // refreshSuggestionsInStore calls (which only know about on-device rows)
      // don't overwrite it. Falls back to the topic-matched count if the query failed.
      useForYouStore.getState().setCounts(
        recentCount || topicResult.serverArticleIds.length,
        useForYouStore.getState().relevantArticleCount,
      );

      // Step 2: diff (status intentionally not published — see Step 1 note).
      this._transitionTo('diffing');
      logger.info('[FeedSyncMachine] → diffing');
      await feedPersistence.updateMachineState('diffing');

      if (ctx.signal.aborted) return;
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
        this._transitionTo('scoring');
        logger.info('[FeedSyncMachine] → scoring (no new articles, silent)');
        await feedPersistence.updateMachineState('scoring');

        if (ctx.signal.aborted) return;
        await steps.stepScore(ctx);

        await flushSuggestionsRefresh();
        this._transitionTo('done');
        useForYouStore.getState().setLastSyncAt(Date.now());
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
      this._transitionTo('hydrating');
      publishSyncStatus('hydrating');
      await feedPersistence.updateMachineState('hydrating');

      await this._awaitResumeIfPaused();
      if (ctx.signal.aborted) return;

      const total = diffResult.missingIds.length;
      const hydrateResult = await steps.stepHydratePersistEnqueue(diffResult, ctx, {
        onProgress: (completed) => {
          ctx.reportProgress({ step: 'hydrating', current: completed, total });
          publishSyncStatus('hydrating', { progress: { current: completed, total } });
        },
        awaitResumeIfPaused: () => this._awaitResumeIfPaused(),
        // A1: coalesce the per-chunk store refreshes into a leading+trailing
        // throttle instead of a full reload after every 25-item chunk.
        refreshStore: () => requestSuggestionsRefresh(),
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
      this._transitionTo('scoring');
      publishSyncStatus('scoring');
      await feedPersistence.updateMachineState('scoring');

      if (ctx.signal.aborted) return;
      await steps.stepScore(ctx);

      // Done
      await flushSuggestionsRefresh();
      this._transitionTo('done');
      publishSyncStatus('done');
      useForYouStore.getState().setLastSyncAt(Date.now());
      try {
        await feedPersistence.clearMachineSnapshot();
      } catch (snapErr) {
        logger.captureException(snapErr, {
          tags: { service: 'FeedSyncMachine', step: 'clearMachineSnapshot' },
        });
      }

      // Auto-reset to idle after 2s so the UI can show "done" briefly
      setTimeout(() => {
        if (this._state === 'done') {
          this._transitionTo('idle');
          publishSyncStatus('idle');
        }
      }, 2_000);

    } catch (err) {
      const errorCode = classifyError(err);

      // `no-topics-configured` is the normal state for a user who hasn't
      // generated interests yet — not a failure. Treat it as a clean, terminal
      // "no work" outcome: show the add-interests prompt, reset to idle, and
      // return WITHOUT throwing so the scheduler marks the job completed (no
      // 3× retry, no Sentry error). Recovery is the user adding interests.
      if (errorCode === 'no-topics-configured') {
        publishSyncError('no-topics-configured', undefined, this._state);
        this._state = 'idle'; // force reset — bypasses transition guard, valid from any state
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
        // Sticky banner state: persists across the transient fetch/diff
        // statuses each polling cycle publishes, so the "limit reached" notice
        // stays visible until a sync delivers articles again or the reset
        // passes. Fall back to the next UTC midnight if the server omitted it.
        useForYouStore.getState().setDailyLimitResetAt(resetAt ?? nextUtcMidnightMs());
        publishSyncError('daily-limit', resetAt, this._state);
        void toastManager.showNotifiedToast({
          type: 'feed_info',
          source: 'feed-sync',
          title: 'notificationCenter.dailyLimitTitle',
          body: 'notificationCenter.dailyLimitBody',
          action: 'info',
          icon: 'hourglass-empty',
        });
        this._state = 'idle';
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
      if (this._state !== 'failed' && this._state !== 'done') {
        this._transitionTo('failed');
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

  private _transitionTo(next: FeedSyncState): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (allowed && !allowed.includes(next)) {
      throw new InvalidTransitionError(this._state, next);
    }
    this._state = next;
  }

  private _awaitResumeIfPaused(): Promise<void> {
    if (!this._paused) return Promise.resolve();
    return new Promise((resolve) => {
      this._resumeCallback = () => {
        this._resumeCallback = null;
        resolve();
      };
    });
  }
}

export const feedSyncMachine = new FeedSyncMachine();
