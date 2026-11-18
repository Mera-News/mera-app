import { createElement } from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { Q } from '@nozbe/watermelondb';
import i18next from 'i18next';

import database from '@/lib/database';
import appSchema from '@/lib/database/schema';
import type { InferenceJobType } from '@/lib/database/models/InferenceJob';
import { deleteOlderThan } from '@/lib/database/services/notification-service';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { PlatformHost } from '@/lib/platform';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { abortRun } from '@/lib/services/scoring-pipeline';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { resync } from '@/lib/sync/commands';
import { COMMAND_REGISTRY_VERSION, CommandError } from '@/lib/sync/command';
import { createSyncSession, MARKS_TICK_MS } from '@/lib/sync/session';
import { SyncVersionError } from '@/lib/sync/tables';
import { show } from '@/lib/toast/toast-queue';

import { holdFeedSyncForMode } from './mode-hold';
import { fromSyncVersionError, PodError, pull, resolveVersion, send } from './pod-client';
import { recordPodError, recordPodOk, resetPodHealth } from './pod-health';
import { podFeedSyncTask } from './pod-sync-task';
import { podConfig, podPaired } from './pod-state';
import { currentPodSink, setPodSink } from './pod-sink';

// Each of these reads or ranks news on the phone, which the server does while paired.
export const TASKS_PAUSED_WHILE_PAIRED = [
  'inference-recover',
  'persona-geo',
  'persona-hygiene',
  'sanity-backfill',
  'feedback-cycle',
  'data-cleanup',
  'fact-check-reconcile',
  'persona-migration',
] as const;

const JOB_TYPES = {
  topic_gen: true,
  persona_summary: true,
  story_headline: true,
  tracked_story_migrate: true,
  topic_combo: true,
} satisfies Record<InferenceJobType, true>;
export const ALL_JOB_TYPES = Object.keys(JOB_TYPES) as InferenceJobType[];

const HASHES_KEY = 'pod_sync_hashes';
const LOCAL = { schemaVersion: appSchema.version, registry: COMMAND_REGISTRY_VERSION };
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

type Session = ReturnType<typeof createSyncSession>;
let session: Session | null = null;
let entering: Promise<void> | null = null;
let keptFeedSync: TaskDefinition | undefined;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let appStateSub: NativeEventSubscription | null = null;
let halted: PodError | null = null;
let lastPruneAt = 0;

const target = () => {
  const cfg = podConfig();
  if (!cfg) throw new PodError('failed');
  return cfg;
};

// Nothing is sent while halted. A refused token stays halted until the mode is entered again; a version
// difference is tried again once on the next foreground, or by Clear feed cache.
const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
  if (halted) throw halted;
  return call();
};

async function readHashes(): Promise<Record<string, string>> {
  try {
    const raw = await getSetting(HASHES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function saveHashes(s: Session): Promise<void> {
  try {
    await setSetting(HASHES_KEY, JSON.stringify(s.hashes()));
  } catch {
    logger.warn('pod: could not remember the applied hashes');
  }
}

function makeSession(initialHashes: Record<string, string>): Session {
  return createSyncSession({
    local: LOCAL,
    initialHashes,
    send: (commands, request) => guarded(() => send(target(), commands, request)),
    pull: (request) => guarded(() => pull(target(), request)),
    onStrayWrite: (table) => logger.addBreadcrumb('pod: a local write to a served table', 'pod', { table }, 'warning'),
  });
}

/** Turns a failure of a sync call into the server error it means, recording health and halting where a retry cannot help. */
async function describeFailure(e: unknown): Promise<PodError | null> {
  let error: PodError | null = e instanceof PodError ? e : e instanceof SyncVersionError ? fromSyncVersionError(e) : null;
  if (!error) return null;
  const cfg = podConfig();
  if (error.code === 'version' && cfg) error = new PodError(await resolveVersion(cfg, LOCAL));
  recordPodError(error);
  if (error.code === 'refused' || error.code === 'phone-old' || error.code === 'server-old') halted = error;
  return error;
}

type ToastKey = 'ownServices.pod.toast.failed' | 'ownServices.pod.toast.unreachable' | 'ownServices.pod.status.refused';

const toastKey = (e: unknown): ToastKey | null => {
  if (e instanceof CommandError) return e.code === 'earlier_change_failed' ? null : 'ownServices.pod.toast.failed';
  if (e instanceof PodError && e.code === 'unreachable') return 'ownServices.pod.toast.unreachable';
  if (e instanceof PodError && e.code === 'refused') return 'ownServices.pod.status.refused';
  return 'ownServices.pod.toast.failed';
};

function toast(key: ToastKey): void {
  const title = i18next.t(key);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const MeraToast = require('@/components/custom/toast/MeraToast').default;
  show({ render: () => createElement(MeraToast, { tone: 'error', title }) });
}

async function flush(s: Session): Promise<void> {
  try {
    await s.tick();
    if (session === s) void saveHashes(s);
  } catch (e) {
    await describeFailure(e);
  }
}

function startTick(): void {
  if (!tickTimer) tickTimer = setInterval(() => session && void flush(session), MARKS_TICK_MS);
}
function stopTick(): void {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

async function enter(): Promise<void> {
  if (session || !podPaired()) return;
  halted = null;
  holdFeedSyncForMode(true);
  for (const name of TASKS_PAUSED_WHILE_PAIRED) AppScheduler.pauseTask(name);
  inferenceQueue.hold(ALL_JOB_TYPES);
  await abortRun('pod');
  // Waits out a job already running, so its local writes land before the sink exists.
  await inferenceQueue.pause();
  inferenceQueue.resume();
  await database.write(async () => {
    const pending = await database.get('inference_jobs').query(Q.where('status', 'pending')).fetch();
    await database.batch(...pending.map((r) => r.prepareDestroyPermanently()));
  });
  keptFeedSync = AppScheduler.definition('feed-sync');
  AppScheduler.register(podFeedSyncTask);
  // A breaker pause from before does not apply to the server.
  AppScheduler.resumeTask('feed-sync');
  session = makeSession(await readHashes());
  setPodSink(sinkFor(session));
  startTick();
  if (AppState.currentState !== 'active') stopTick();
  appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      startTick();
      retryAfterVersionHalt();
    } else {
      stopTick();
      if (session) void flush(session);
    }
  });
}

/** One try per foreground after a version difference: the server or the app may have been updated meanwhile. */
function retryAfterVersionHalt(): void {
  if (!halted || halted.code === 'refused' || !session) return;
  halted = null;
  void syncPod().catch(() => undefined);
}

export function enterPodMode(): Promise<void> {
  if (session) return Promise.resolve();
  return (entering ??= enter().finally(() => {
    entering = null;
  }));
}

export async function leavePodMode(): Promise<void> {
  if (entering) await entering.catch(() => undefined);
  if (!session) return;
  stopTick();
  appStateSub?.remove();
  appStateSub = null;
  setPodSink(undefined);
  session.stop();
  session = null;
  halted = null;
  lastPruneAt = 0;
  if (keptFeedSync) AppScheduler.register(keptFeedSync);
  keptFeedSync = undefined;
  holdFeedSyncForMode(false);
  for (const name of TASKS_PAUSED_WHILE_PAIRED) AppScheduler.resumeTask(name);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isBreakerOpen } = require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');
  if (isBreakerOpen()) AppScheduler.pauseTask('feed-sync');
  else AppScheduler.resumeTask('feed-sync');
  inferenceQueue.hold([]);
  resetPodHealth();
  try {
    await deleteSetting(HASHES_KEY);
  } catch {
    logger.warn('pod: could not delete the remembered hashes');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  void (require('@/lib/apollo-client').default as { clearStore(): Promise<unknown> }).clearStore().catch(() => undefined);
}

export const podSink = (): PlatformHost['podCommand'] => currentPodSink();

function sinkFor(s: Session): NonNullable<PlatformHost['podCommand']> {
  return async ({ name, args }) => {
    try {
      const result = await s.command(name, args);
      recordPodOk();
      void saveHashes(s);
      return result;
    } catch (e) {
      await describeFailure(e);
      const key = toastKey(e);
      if (key) toast(key);
      throw e;
    }
  };
}

async function pruneNotifications(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  try {
    await deleteOlderThan(now - NOTIFICATION_TTL_MS);
  } catch {
    logger.warn('pod: could not prune old notifications');
  }
}

async function syncWith(s: Session): Promise<void> {
  try {
    await s.syncNow();
  } catch (e) {
    throw (await describeFailure(e)) ?? e;
  }
  recordPodOk();
  await saveHashes(s);
}

export async function syncPod(): Promise<void> {
  if (!session) throw new PodError('failed');
  await syncWith(session);
  await pruneNotifications();
}

/** The OS wake: a sync with the server and nothing else; no sink is set for a session made only for it. */
export async function syncPodInWake(): Promise<void> {
  if (session) return syncPod();
  if (!podPaired()) throw new PodError('failed');
  const s = makeSession(await readHashes());
  try {
    await syncWith(s);
  } finally {
    s.stop();
  }
}

/** Clear feed cache while paired: forget what the phone holds, ask the server to read, and pull every table again. */
export async function refreshFromPod(): Promise<void> {
  if (!session) throw new PodError('failed');
  if (halted?.code === 'refused') throw halted;
  halted = null;
  try {
    await deleteSetting(HASHES_KEY);
  } catch {
    logger.warn('pod: could not delete the remembered hashes');
  }
  session.stop();
  session = makeSession({});
  setPodSink(sinkFor(session));
  useFeedOrderStore.getState().reset();
  await resync();
  await syncPod();
}
