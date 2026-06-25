import { useNetworkStore } from '@/lib/stores/network-store';
import logger from '@/lib/logger';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { ArticleService } from '@/lib/article-service';
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
  hydrating:            ['persisting', 'paused-offline', 'failed'],
  persisting:           ['scoring', 'failed'],
  scoring:              ['done', 'failed'],
  'paused-offline':     ['fetching-topic-ids', 'diffing', 'persisting', 'failed'],
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
      deactivateKeepAwake(KEEP_AWAKE_TAG);
      this._networkUnsubscribe?.();
      this._networkUnsubscribe = null;
    }
  }

  private async _run(personaId: string, ctx: TaskContext): Promise<void> {
    logger.info('[FeedSyncMachine] run start');
    try {
      // Step 1: fetch topic IDs
      this._transitionTo('fetching-topic-ids');
      publishSyncStatus('fetching-topic-ids');
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

      // Step 2: diff
      this._transitionTo('diffing');
      publishSyncStatus('diffing');
      logger.info('[FeedSyncMachine] → diffing');
      await feedPersistence.updateMachineState('diffing');

      if (ctx.signal.aborted) return;
      const diffResult = await steps.stepDiff(topicResult, ctx);

      if (diffResult.missingIds.length === 0) {
        // No new articles and nothing deleted — but still run scoring in case
        // articles from a prior run are waiting to be analysed (e.g. when the
        // previous scoring step failed transiently and left unscoredCount > 0).
        this._transitionTo('scoring');
        publishSyncStatus('scoring');
        logger.info('[FeedSyncMachine] → scoring (no new articles)');
        await feedPersistence.updateMachineState('scoring');

        if (ctx.signal.aborted) return;
        await steps.stepScore(ctx);

        await refreshSuggestionsInStoreUnsafe();
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

        setTimeout(() => {
          if (this._state === 'done') {
            this._transitionTo('idle');
            publishSyncStatus('idle');
          }
        }, 2_000);
        return;
      }

      // Step 3: hydrate
      this._transitionTo('hydrating');
      publishSyncStatus('hydrating');
      await feedPersistence.updateMachineState('hydrating');

      await this._awaitResumeIfPaused();
      if (ctx.signal.aborted) return;

      const total = diffResult.missingIds.length;
      const hydrateResult = await steps.stepHydrate(diffResult, ctx, (completed) => {
        ctx.reportProgress({ step: 'hydrating', current: completed, total });
        publishSyncStatus('hydrating', { progress: { current: completed, total } });
      });
      useForYouStore.getState().resetHydrationProgress();

      // Step 4: persist
      this._transitionTo('persisting');
      publishSyncStatus('persisting');
      await feedPersistence.updateMachineState('persisting');

      if (ctx.signal.aborted) return;
      await steps.stepPersist(hydrateResult, ctx);
      // Daily cap banner: if this hydrate was partially clipped, surface the
      // "limit reached" notice now (we still delivered what fit) rather than
      // waiting for the next fully-blocked cycle. A fully-unclipped delivery
      // means we're under the cap — clear it.
      useForYouStore.getState().setDailyLimitResetAt(
        hydrateResult.dailyLimitReached
          ? hydrateResult.resetAt
            ? Date.parse(hydrateResult.resetAt)
            : nextUtcMidnightMs()
          : null,
      );
      // Progressive rendering: refresh store after persist so articles appear
      await refreshSuggestionsInStoreUnsafe();

      // Step 5: score
      this._transitionTo('scoring');
      publishSyncStatus('scoring');
      await feedPersistence.updateMachineState('scoring');

      if (ctx.signal.aborted) return;
      await steps.stepScore(ctx);

      // Done
      await refreshSuggestionsInStoreUnsafe();
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
