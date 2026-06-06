import { useNetworkStore } from '@/lib/stores/network-store';
import logger from '@/lib/logger';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';
import type { TaskContext } from '../scheduler-types';
import * as feedPersistence from './feed-sync-persistence';
import * as steps from './feed-sync-steps';
import { classifyError, publishSyncError, publishSyncStatus } from './feed-sync-status';
import type { FeedSyncState } from './feed-sync-types';
import { InvalidTransitionError, NETWORK_DEPENDENT_STATES } from './feed-sync-types';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'mera-feed-sync';

const VALID_TRANSITIONS: Partial<Record<FeedSyncState, FeedSyncState[]>> = {
  idle:                 ['fetching-topic-ids'],
  'fetching-topic-ids': ['diffing', 'paused-offline', 'failed'],
  diffing:              ['hydrating', 'scoring', 'done', 'failed'],
  hydrating:            ['persisting', 'paused-offline', 'failed'],
  persisting:           ['scoring', 'failed'],
  scoring:              ['done', 'failed'],
  'paused-offline':     ['fetching-topic-ids', 'failed'],
  failed:               ['idle'],
  done:                 ['idle'],
};

class FeedSyncMachine {
  private _state: FeedSyncState = 'idle';
  private _networkUnsubscribe: (() => void) | null = null;
  private _paused = false;
  private _resumeCallback: (() => void) | null = null;

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
    try {
      // Step 1: fetch topic IDs
      this._transitionTo('fetching-topic-ids');
      publishSyncStatus('fetching-topic-ids');
      await feedPersistence.updateMachineState('fetching-topic-ids');

      await this._awaitResumeIfPaused();
      if (ctx.signal.aborted) return;

      const topicResult = await steps.stepFetchTopicIds(personaId, ctx);

      // Step 2: diff
      this._transitionTo('diffing');
      publishSyncStatus('diffing');
      await feedPersistence.updateMachineState('diffing');

      if (ctx.signal.aborted) return;
      const diffResult = await steps.stepDiff(topicResult, ctx);

      if (diffResult.missingIds.length === 0) {
        // No new articles and nothing deleted — but still run scoring in case
        // articles from a prior run are waiting to be analysed (e.g. when the
        // previous scoring step failed transiently and left unscoredCount > 0).
        this._transitionTo('scoring');
        publishSyncStatus('scoring');
        await feedPersistence.updateMachineState('scoring');

        if (ctx.signal.aborted) return;
        await steps.stepScore(ctx);

        await refreshSuggestionsInStoreUnsafe();
        this._transitionTo('done');
        publishSyncStatus('done');
        useForYouStore.getState().setLastSyncAt(Date.now());
        await feedPersistence.clearMachineSnapshot();

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
      await feedPersistence.clearMachineSnapshot();

      // Auto-reset to idle after 2s so the UI can show "done" briefly
      setTimeout(() => {
        if (this._state === 'done') {
          this._transitionTo('idle');
          publishSyncStatus('idle');
        }
      }, 2_000);

    } catch (err) {
      const errorCode = classifyError(err);
      const failedAtState = this._state; // capture before transition
      const retryAt = undefined; // scheduler handles retry timing
      this._transitionTo('failed');
      publishSyncError(errorCode, retryAt, failedAtState);
      await feedPersistence.saveMachineSnapshot({
        state: 'failed',
        startedAt: Date.now(),
        errorCode,
      });
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
