// A phone paired to its own server: entering and leaving the mode, the sync, the sink for edits, the
// marks tick and the remembered hashes. The server is the fake one; everything else is real.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import '@/lib/scheduler/tasks/feed-sync-task';

import * as Sentry from '@sentry/react-native';
import i18next from 'i18next';
import { Q } from '@nozbe/watermelondb';

import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import { BACKUP_SETTING_KEYS, isBackedUpSettingKey } from '@/lib/backup/allowlist';
import database from '@/lib/database';
import { addFact } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import appSchema from '@/lib/database/schema';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { platform } from '@/lib/platform';
import { PodError } from '@/lib/own-services/pod-client';
import { resetPodHealth, usePodHealth } from '@/lib/own-services/pod-health';
import { ALL_JOB_TYPES, TASKS_PAUSED_WHILE_PAIRED, enterPodMode, leavePodMode, podSink, syncPod } from '@/lib/own-services/pod-runner';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { setReportSecrets } from '@/lib/own-services/report-secrets';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import { MARKS_TICK_MS } from '@/lib/sync/session';
import { buildSnapshot, type Snapshot } from '@/lib/sync/snapshot';
import { isSyncSettingKey } from '@/lib/sync/tables';
import { resetToastQueue, useToastQueue } from '@/lib/toast/toast-queue';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { clearFeedCacheAndResync } from '@/components/custom/config-mera/clear-feed-cache';
import {
  advanceUntil,
  fakePod,
  gatewayCalls,
  initI18nEn,
  podSnapshotFrom,
  POD_URL,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { cleanupFeedSync, recordOps, resetFeedSyncMemory, servePersona } from '../feed-sync/steps/support';
import { resetScheduler } from '../scheduler/core/support';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const HASHES_KEY = 'pod_sync_hashes';
const LOCAL = { schemaVersion: appSchema.version, registry: COMMAND_REGISTRY_VERSION };
const PAIRING = { v: 1 as const, baseUrl: POD_URL, deviceId: 'device-1', token: TOKEN, podName: 'Home pod', pairedAt: 1 };
const COPY = {
  unreachable: "Can't reach your server. Nothing was changed.",
  failed: "Your server couldn't save this. Try again.",
  refused: 'Your server refused this phone. Pair again.',
};

let pod: ReturnType<typeof fakePod>;
const realTurn = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const start = Date.now(); !(await cond()); await realTurn()) if (Date.now() - start > ms) throw new Error('timed out');
};

const factIds = async () => (await database.get('facts').query().fetch()).map((r) => r.id).sort();
const podFact = (id: string, statement = 'Lives in Utrecht') => watermelonRowSink.createRows('facts', [{ id, statement, created_at: 1, updated_at: 1 }]);
const toasts = () => useToastQueue.getState().entries.map((e) => (e.render({ id: e.id }) as { props: { title?: string; body?: string } }).props.title ?? '');
const requests = (path: string) => pod.requests.filter((r) => r.path === path);
const hostCommand = () => platform('pod-runner test').podCommand;

/** A server that holds one fact, and a phone that has already pulled it. */
async function pairedWithFact() {
  pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
  await savePairing(PAIRING);
  await enterPodMode();
  await syncPod();
}

beforeAll(() => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

beforeEach(async () => {
  await initI18nEn();
  i18next.addResourceBundle('en', 'translation', { ownServices: { pod: { toast: { unreachable: COPY.unreachable, failed: COPY.failed } } } }, true, false);
  resetScheduler();
  resetBreaker();
  resetFeedSyncMemory();
  resetPodHealth();
  resetToastQueue();
  podState.resetMemory();
  setAppState('active');
  pod = fakePod({ token: TOKEN });
  (Sentry.addBreadcrumb as jest.Mock).mockClear();
});

afterEach(async () => {
  await leavePodMode();
  await forgetPairing();
  resetToastQueue();
  await inferenceQueue.stop();
  for (const t of ALL_JOB_TYPES) __setJobHandlerForTests(t, undefined);
  AppScheduler.dispose();
  cleanupFeedSync();
  setReportSecrets('pod', null);
  jest.restoreAllMocks();
});

describe('not paired', () => {
  it('has no sink and no session, and entering changes nothing', async () => {
    const before = AppScheduler.definition('feed-sync');
    await enterPodMode();

    expect(podSink()).toBeUndefined();
    expect(hostCommand()).toBeUndefined();
    expect(AppScheduler.definition('feed-sync')).toBe(before);
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
    await expect(syncPod()).rejects.toMatchObject({ code: 'failed', ownServer: true });
    expect(pod.requests).toEqual([]);
  });

  it('an edit runs on the phone as today', async () => {
    await addFact('I follow cycling');
    expect(await factIds()).toHaveLength(1);
    expect(pod.requests).toEqual([]);
  });
});

describe('entering', () => {
  it('pauses the listed tasks, swaps feed-sync for a sync with the server, and sets the sink', async () => {
    await savePairing(PAIRING);
    const original = AppScheduler.definition('feed-sync');
    await enterPodMode();

    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(true);
    expect(AppScheduler.isPaused('feed-sync')).toBe(false);
    for (const name of ['entitlement-sync', 'push-token-check', 'apollo-cache-evict', 'feedback-request-sync']) expect(TASKS_PAUSED_WHILE_PAIRED).not.toContain(name);
    const swapped = AppScheduler.definition('feed-sync')!;
    expect(swapped).not.toBe(original);
    expect(swapped.conditions?.map((c) => c.type)).toEqual(['network', 'db-ready']);
    expect(hostCommand()).toBeDefined();
    expect(pod.requests).toEqual([]);
  });

  it('is idempotent', async () => {
    await savePairing(PAIRING);
    await enterPodMode();
    const sink = AppScheduler.definition('feed-sync');
    await enterPodMode();
    expect(AppScheduler.definition('feed-sync')).toBe(sink);
  });

  it('a trigger syncs with the server, sends nothing to Mera, and the rows arrive', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    await enterPodMode();
    const ops = recordOps();

    expect(await AppScheduler.trigger('feed-sync')).toBe('ran');

    expect(requests('/snapshot')).toHaveLength(1);
    expect(await ops.all()).toEqual([]);
    expect(await factIds()).toEqual(['pod-fact-1']);
  });

  it('clears pending jobs, holds the queue, and runs a held job again after leaving', async () => {
    const handler = jest.fn(async () => ({}));
    __setJobHandlerForTests('story_headline', handler);
    await enqueueJob('story_headline', {});
    await savePairing(PAIRING);
    await enterPodMode();
    const jobs = () => database.get('inference_jobs').query(Q.where('status', 'pending')).fetch();
    expect(await jobs()).toHaveLength(0);

    await enqueueJob('story_headline', {});
    await inferenceQueue.start();
    inferenceQueue.notify();
    await new Promise((r) => setTimeout(r, 150));
    expect(handler).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(1);

    await leavePodMode();
    await until(() => handler.mock.calls.length === 1);
  });

  it('does no reading on the phone over a sync, a foreground and a pull to refresh', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    await enterPodMode();
    const ops = recordOps();

    await syncPod();
    setAppState('background');
    setAppState('active');
    await AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
    await realTurn();

    expect(gatewayCalls()).toEqual([]);
    expect(await ops.all()).toEqual([]);
    expect(pod.requests.some((r) => r.path === '/v1/chat/completions')).toBe(false);
    expect(await database.get('article_suggestions').query().fetchCount()).toBe(0);
    expect((await database.get('facts').query().fetchCount())).toBe(1);
  });
});

describe('the sink', () => {
  it('an edit goes as one command and the phone then holds the server rows, with no row of its own', async () => {
    const both = await podSnapshotFrom(async () => {
      await podFact('pod-fact-1');
      await podFact('pod-fact-2', 'I follow cycling');
    });
    await pairedWithFact();
    pod.snapshot = both;
    pod.requests.length = 0;

    await addFact('I follow cycling');

    const commands = requests('/commands');
    expect(commands).toHaveLength(1);
    expect(commands[0].body.commands.map((c: { name: string }) => c.name)).toEqual(['addFact']);
    expect(await factIds()).toEqual(['pod-fact-1', 'pod-fact-2']);
  });

  it('a command the server refuses changes nothing here, toasts once, and rejects', async () => {
    await pairedWithFact();
    pod.onCommand = () => ({ error: { code: 'invalid', message: 'no' } });

    await expect(addFact('I follow cycling')).rejects.toMatchObject({ code: 'invalid' });

    expect(await factIds()).toEqual(['pod-fact-1']);
    expect(toasts()).toEqual([COPY.failed]);
  });

  it('a server that is down: the writer rejects, the toast says so, health is unreachable, and the next success clears it', async () => {
    await pairedWithFact();
    pod.down();

    await expect(addFact('x')).rejects.toBeInstanceOf(PodError);

    expect(toasts()).toEqual([COPY.unreachable]);
    expect(usePodHealth.getState().health).toBe('unreachable');
    expect(await factIds()).toEqual(['pod-fact-1']);
    pod.up();
    await syncPod();
    expect(usePodHealth.getState().health).toBe('ok');
  });

  it('a refused token: the refused line, health refused, and no further request is sent', async () => {
    await pairedWithFact();
    pod.tokens.clear();

    await expect(addFact('x')).rejects.toMatchObject({ code: 'refused' });
    expect(toasts()).toEqual([COPY.refused]);
    expect(usePodHealth.getState().health).toBe('refused');

    const sent = pod.requests.length;
    await expect(syncPod()).rejects.toMatchObject({ code: 'refused', ownServer: true });
    expect(pod.requests).toHaveLength(sent);
  });

  it('a second change queued behind a failed one shows no second toast', async () => {
    await pairedWithFact();
    pod.onCommand = () => ({ error: { code: 'invalid', message: 'no' } });
    await Promise.allSettled([addFact('one'), addFact('two')]);
    expect(toasts()).toEqual([COPY.failed]);
  });

  it.each([
    ['phone-old', 1],
    ['server-old', -1],
  ] as const)('a %s version difference sets that health and stays through a sync and a command', async (health, shift) => {
    await savePairing(PAIRING);
    await enterPodMode();
    pod.versions.schemaVersion = LOCAL.schemaVersion + shift;

    await expect(syncPod()).rejects.toMatchObject({ code: health });
    expect(usePodHealth.getState().health).toBe(health);
    await expect(syncPod()).rejects.toMatchObject({ code: health });
    await expect(addFact('x')).rejects.toBeDefined();
    expect(usePodHealth.getState().health).toBe(health);
    expect(requests('/commands')).toHaveLength(0);
  });
});

describe('what a sync never replaces', () => {
  it('a phone-only table and an identity setting keep the phone value', async () => {
    const served: Snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await database.write(() => database.get('conversations').create((r: any) => { r._raw.id = 'phone-conversation'; r.surface = 'chat'; r.createdAt = new Date(1); }));
    await setSetting('cached_user_id', 'phone-user');
    served.tables.conversations = { hash: 'c', mode: 'replace', rows: [{ id: 'pod-conversation', surface: 'chat', created_at: 2 }] };
    served.tables.settings = { hash: 's', mode: 'replace', rows: [{ id: 's1', key: 'cached_user_id', value: 'pod-user' }] };
    pod.snapshot = served;
    await savePairing(PAIRING);
    await enterPodMode();

    await syncPod();

    expect((await database.get('conversations').query().fetch()).map((r) => r.id)).toEqual(['phone-conversation']);
    expect(await getSetting('cached_user_id')).toBe('phone-user');
    expect(await factIds()).toEqual(['pod-fact-1']);
  });

  it('a local write to a served table is reported once with the table name, and an apply is not', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    await enterPodMode();
    await syncPod();
    const stray = () => (Sentry.addBreadcrumb as jest.Mock).mock.calls.map((c) => c[0]).filter((b) => b.category === 'pod');
    expect(stray()).toEqual([]);

    for (let i = 0; i < 2; i++) await database.write(() => database.get('facts').create((r: any) => { r.statement = `local ${i}`; }));
    await realTurn();

    expect(stray()).toHaveLength(1);
    expect(JSON.stringify(stray()[0])).toContain('facts');
  });
});

describe('remembered hashes', () => {
  it('are stored after a sync, never served and never backed up, and a cold start sends them', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    await enterPodMode();
    await syncPod();

    const stored = JSON.parse((await getSetting(HASHES_KEY))!);
    expect(Object.keys(stored)).toContain('facts');
    expect(isSyncSettingKey(HASHES_KEY)).toBe(false);
    expect(isBackedUpSettingKey(HASHES_KEY)).toBe(false);
    expect(BACKUP_SETTING_KEYS).not.toContain(HASHES_KEY);
    const built = await buildSnapshot({ hashes: {}, registry: COMMAND_REGISTRY_VERSION });
    expect(JSON.stringify(built.tables.settings?.rows ?? [])).not.toContain(HASHES_KEY);

    await leavePodMode();
    await setSetting(HASHES_KEY, JSON.stringify(stored));
    pod.requests.length = 0;
    await enterPodMode();
    await syncPod();

    expect(requests('/snapshot')[0].body.hashes).toEqual(stored);
    expect(await factIds()).toEqual(['pod-fact-1']);
  });

  it('are saved after a command too, and deleted on leaving', async () => {
    await pairedWithFact();
    await setSetting(HASHES_KEY, '{}');
    await addFact('x');
    expect(Object.keys(JSON.parse((await getSetting(HASHES_KEY))!))).toContain('facts');

    await leavePodMode();
    expect(await getSetting(HASHES_KEY)).toBeNull();
  });

  it('clearing the feed cache while paired sends resync with empty hashes and every table comes back with rows', async () => {
    await pairedWithFact();
    pod.requests.length = 0;
    useFeedOrderStore.setState({ order: ['old-1', 'old-2'], verdicts: { 'old-1': { verdict: 'kept' } as never } });

    await clearFeedCacheAndResync();

    expect(requests('/commands')[0].body.commands.map((c: { name: string }) => c.name)).toEqual(['resync']);
    expect(requests('/commands')[0].body.hashes).toEqual({});
    expect(requests('/snapshot')).toHaveLength(1);
    expect(await factIds()).toEqual(['pod-fact-1']);
    expect(useFeedOrderStore.getState().order).toEqual([]);
    expect(useFeedOrderStore.getState().verdicts).toEqual({});
    expect((Sentry.addBreadcrumb as jest.Mock).mock.calls.filter((c) => c[0].category === 'pod')).toEqual([]);
  });
});

describe('marks', () => {
  it('go out on the tick while the app is in front, and once when it goes to the background', async () => {
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    await savePairing(PAIRING);
    await enterPodMode();
    const marksIn = () => requests('/commands').filter((r) => r.body.commands[0].name === 'marks');

    await recordOpen({ articleId: 'a1', surface: 'feed' });
    await jest.advanceTimersByTimeAsync(MARKS_TICK_MS);
    await advanceUntil(() => marksIn().length === 1, 10_000);

    await recordOpen({ articleId: 'a2', surface: 'feed' });
    setAppState('background');
    await advanceUntil(() => marksIn().length === 2, 10_000);
    await recordOpen({ articleId: 'a3', surface: 'feed' });
    await jest.advanceTimersByTimeAsync(MARKS_TICK_MS * 3);
    await realTurn();
    expect(marksIn()).toHaveLength(2);

    setAppState('active');
    await leavePodMode();
    expect(jest.getTimerCount()).toBe(0);
    setAppState('background');
    await jest.advanceTimersByTimeAsync(MARKS_TICK_MS * 3);
    expect(marksIn()).toHaveLength(2);
  });

  it('go before a sync', async () => {
    await savePairing(PAIRING);
    await enterPodMode();
    await recordOpen({ articleId: 'a1', surface: 'feed' });

    await syncPod();

    expect(requests('/commands')[0].body.commands[0].name).toBe('marks');
  });
});

describe('boot', () => {
  it('the scheduler\'s first kick after a paired boot syncs with the server and asks Mera for no feed or scoring', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    podState.resetMemory();
    await signInFixtureAccount();
    useDatabaseStore.setState({ ready: true });
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    const ops = recordOps();

    await platform('pod-runner test').hydrateHostState!();
    const init = AppScheduler.init();
    await jest.advanceTimersByTimeAsync(100);
    await init;
    AppScheduler.onStoresHydrated();
    await advanceUntil(() => requests('/snapshot').length === 1, 20_000);

    expect(await ops.all()).toEqual([]);
    expect(gatewayCalls()).toEqual([]);
    expect(await factIds()).toEqual(['pod-fact-1']);
  });

  it('hydrating the app state with a stored pairing enters the mode before any task runs', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    podState.resetMemory();

    await platform('pod-runner test').hydrateHostState!();

    expect(hostCommand()).toBeDefined();
    expect(AppScheduler.isPaused('persona-geo')).toBe(true);
    await AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
    expect(requests('/snapshot')).toHaveLength(1);
    expect(await factIds()).toEqual(['pod-fact-1']);
  });
});

describe('a version difference', () => {
  it('stops syncing until the next foreground, then tries exactly once', async () => {
    await savePairing(PAIRING);
    await enterPodMode();
    pod.versions = { ...pod.versions, schemaVersion: pod.versions.schemaVersion + 1 };

    await expect(syncPod()).rejects.toMatchObject({ code: 'phone-old' });
    const after = requests('/snapshot').length;
    await expect(syncPod()).rejects.toMatchObject({ code: 'phone-old' });
    expect(requests('/snapshot')).toHaveLength(after);

    setAppState('background');
    setAppState('active');
    await until(() => requests('/snapshot').length === after + 1);
    await realTurn();
    expect(requests('/snapshot')).toHaveLength(after + 1);
    expect(usePodHealth.getState().health).toBe('phone-old');

    pod.versions = { ...pod.versions, schemaVersion: pod.versions.schemaVersion - 1 };
    setAppState('background');
    setAppState('active');
    await until(() => usePodHealth.getState().health === 'ok');
  });

  it('clearing the feed cache tries again, but a refused token stays stopped', async () => {
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await savePairing(PAIRING);
    await enterPodMode();
    pod.versions = { ...pod.versions, registry: pod.versions.registry + 1 };
    await expect(syncPod()).rejects.toMatchObject({ code: 'phone-old' });
    pod.versions = { ...pod.versions, registry: pod.versions.registry - 1 };
    await clearFeedCacheAndResync();
    expect(usePodHealth.getState().health).toBe('ok');

    pod.revoked.add(TOKEN);
    await expect(syncPod()).rejects.toMatchObject({ code: 'refused' });
    const after = pod.requests.length;
    await expect(clearFeedCacheAndResync()).rejects.toMatchObject({ code: 'refused' });
    setAppState('background');
    setAppState('active');
    await realTurn();
    expect(pod.requests).toHaveLength(after);
  });
});

describe('notifications', () => {
  it('a sync while paired prunes the ones older than 90 days, with no stray-write report', async () => {
    const day = 24 * 60 * 60 * 1000;
    const note = (id: string, created_at: number) => ({ id, type: 'tip', title: 't', body: 'b', status: 'unread', source: 'local', created_at });
    await watermelonRowSink.createRows('notifications', [note('old', Date.now() - 91 * day), note('new', Date.now() - day)]);
    await savePairing(PAIRING);
    await enterPodMode();

    await syncPod();

    expect((await database.get('notifications').query().fetch()).map((r) => r.id)).toEqual(['new']);
    expect((Sentry.addBreadcrumb as jest.Mock).mock.calls.filter((c) => c[0].category === 'pod')).toEqual([]);
  });
});

describe('leaving', () => {
  it('resumes the tasks, restores feed sync, removes the sink, deletes the hashes and leaves nothing running', async () => {
    await pairedWithFact();
    await leavePodMode();

    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(false);
    expect(AppScheduler.isPaused('feed-sync')).toBe(false);
    expect(AppScheduler.definition('feed-sync')?.conditions?.map((c) => c.type)).toContain('authenticated');
    expect(hostCommand()).toBeUndefined();
    expect(await getSetting(HASHES_KEY)).toBeNull();
    // Nothing is left to send: a stray tick, a command or a second leave does nothing.
    pod.requests.length = 0;
    setAppState('background');
    await leavePodMode();
    await realTurn();
    expect(pod.requests).toEqual([]);
  });

  it('evicts the Apollo cache', async () => {
    const client = require('@/lib/apollo-client').default;
    await pairedWithFact();
    client.cache.restore({ ROOT_QUERY: { __typename: 'Query', leftover: 1 } });

    await leavePodMode();
    await until(() => Object.keys(client.cache.extract()).length === 0);
  });

  it('a trigger now reaches Mera and not the server', async () => {
    await signInFixtureAccount();
    useUserStore.setState({ userPersona: { _id: 'persona-1' } as never });
    useDatabaseStore.setState({ ready: true });
    server.use(servePersona({ topics: {} }));
    await pairedWithFact();
    await leavePodMode();
    await forgetPairing();
    pod.requests.length = 0;
    const ops = recordOps();

    await AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });

    expect(await ops.count('GetArticleIdsForPersona')).toBe(1);
    expect(pod.requests).toEqual([]);
  });
});

describe('what never appears', () => {
  it('the token and the address are in no log line, no error message and no error field', async () => {
    await pairedWithFact();
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const errors: unknown[] = [];
    pod.down();
    errors.push(await addFact('secret argument text').catch((e) => e));
    pod.up();
    pod.tokens.clear();
    errors.push(await addFact('secret argument text').catch((e) => e));
    errors.push(await syncPod().catch((e) => e));

    const seen = JSON.stringify([logs.flatMap((s) => s.mock.calls), (Sentry.addBreadcrumb as jest.Mock).mock.calls, errors.map((e) => ({ ...(e as object), message: (e as Error).message }))]);
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain('pod.own.test');
    expect(seen).not.toContain('secret argument text');
  });
});
