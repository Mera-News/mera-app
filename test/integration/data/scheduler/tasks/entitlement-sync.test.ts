// The entitlement-sync scheduler task on the REAL AppScheduler, driving the real syncEntitlement, the
// real Apollo client over MSW (`setScenario({ tier })` is the server's verdict), the subscription store
// and the settings rows the background refresh reads. The sync's own debounce and the RevenueCat
// attribute payload are covered where they live; this file pins what the TASK does with them: it keeps
// the device's memory of tier and daily limit current, a failed read changes nothing, and the
// attribute sync still runs when the entitlement fetch is debounced out.
import { mockGqlError, server, setAppState, setScenario } from '@/test/helpers';
import '@/lib/scheduler/tasks/entitlement-sync-task';

import Purchases from 'react-native-purchases';

import { getSetting } from '@/lib/database/services/setting-service';
import { configureRevenueCat } from '@/lib/revenuecat';
import { resetEntitlementSyncState } from '@/lib/subscription/entitlement-sync';
import { LAST_KNOWN_TIER_SETTING_KEY } from '@/lib/subscription/last-known-tier';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { useUserStore } from '@/lib/stores/user-store';

import {
  MIN,
  T0,
  advanceUntil,
  conditionTypes,
  endTest,
  initScheduler,
  jobRows,
  jobStatuses,
  lastRunInStore,
  lastRunPersisted,
  registeredDefinition,
  runTask,
  seedLocalUser,
  settle,
  startTest,
} from './support';

jest.setTimeout(30_000); // the tick tests step minutes of fake time, which an instrumented run can stretch

const TASK = 'entitlement-sync';

/** Both settings writes are fire-and-forget, so the job ends before they land: poll until the row appears. */
async function settledSetting(key: string): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const value = await getSetting(key);
    if (value !== null) return value;
    await settle(10);
  }
  return null;
}

beforeEach(async () => {
  await startTest(TASK, { signedIn: true });
  seedLocalUser();
  resetEntitlementSyncState();
  useSubscriptionStore.getState().reset();
  setScenario({ tier: 'individual' });
});
afterEach(endTest);

/** Counts the calls of the billing query without changing the default answer. */
function countBilling(): { calls: () => number } {
  let calls = 0;
  server.events.on('request:start', ({ request }) => {
    if (request.url.endsWith('/graphql')) {
      void request
        .clone()
        .json()
        .then((b: { operationName?: string }) => {
          if (b.operationName === 'GetUserBilling') calls += 1;
        });
    }
  });
  return { calls: () => calls };
}

describe('registration', () => {
  it('is a 15 minute foreground and reconnect task gated on exactly network and authenticated, exclusive, 30s, 2 attempts', () => {
    const def = registeredDefinition('@/lib/scheduler/tasks/entitlement-sync-task');

    expect(def).toMatchObject({
      name: TASK,
      frequency: 15 * MIN,
      triggers: ['app-foreground', 'network-reconnect'],
      exclusive: true,
      timeout: 30_000,
      maxAttempts: 2,
    });
    expect(conditionTypes(def)).toEqual(['network', 'authenticated']);
  });
});

describe('the handler', () => {
  it('reads billing into the store and writes the device memory: the last known tier', async () => {
    expect(await runTask(TASK)).toBe('ran');

    expect(useSubscriptionStore.getState().serverTier).toBe('individual');
    expect(await settledSetting(LAST_KNOWN_TIER_SETTING_KEY)).toBe('individual');
    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(lastRunInStore(TASK)).toBeGreaterThanOrEqual(T0);
    expect(await lastRunPersisted(TASK)).toBe(lastRunInStore(TASK));
  });

  it('follows the server tier: Starter is remembered as Starter', async () => {
    setScenario({ tier: 'starter' });

    await runTask(TASK);

    expect(await settledSetting(LAST_KNOWN_TIER_SETTING_KEY)).toBe('starter');
  });

  it('a second run inside the sync debounce (60s) makes no billing request, so a changed verdict waits; after it, it is read', async () => {
    const billing = countBilling();
    await runTask(TASK);
    await settle(5_000);
    expect(billing.calls()).toBe(1);

    setScenario({ tier: 'professional' });
    await runTask(TASK);
    expect(billing.calls()).toBe(1);
    expect(useSubscriptionStore.getState().serverTier).toBe('individual');

    await settle(60_000);
    await runTask(TASK);
    expect(billing.calls()).toBe(2);
    expect(useSubscriptionStore.getState().serverTier).toBe('professional');
    expect(await settledSetting(LAST_KNOWN_TIER_SETTING_KEY)).toBe('professional');
  });

  it('a failed billing read keeps the last known tier, completes the job, and is not debounced (the next run retries at once)', async () => {
    await runTask(TASK);
    await settledSetting(LAST_KNOWN_TIER_SETTING_KEY);
    await settle(61_000);
    setScenario({ tier: 'professional' });
    server.use(mockGqlError('GetUserBilling', 'INTERNAL_SERVER_ERROR'), mockGqlError('GetUserBillingLapseState', 'INTERNAL_SERVER_ERROR'));

    expect(await runTask(TASK)).toBe('ran');

    expect(await jobStatuses(TASK)).toEqual(['completed', 'completed']);
    expect(useSubscriptionStore.getState().serverTier).toBe('individual');
    expect(await getSetting(LAST_KNOWN_TIER_SETTING_KEY)).toBe('individual');

    server.resetHandlers();
    setScenario({ tier: 'professional' });
    await settle(5_000);
    await runTask(TASK);
    expect(useSubscriptionStore.getState().serverTier).toBe('professional');
  });

  it('syncs RevenueCat attributes on every run, even when the entitlement fetch is debounced out, skipping an unchanged payload', async () => {
    configureRevenueCat();
    await runTask(TASK);
    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
    expect(Purchases.setAttributes).toHaveBeenLastCalledWith(expect.objectContaining({ server_tier: 'individual' }));
    await settle(5_000);

    await runTask(TASK); // debounced entitlement, unchanged payload
    expect(Purchases.setAttributes).toHaveBeenCalledTimes(1);
    await settle(5_000);

    useSubscriptionStore.setState({ serverTier: 'professional' });
    await runTask(TASK); // still debounced, but the server tier moved mid-session
    expect(Purchases.setAttributes).toHaveBeenCalledTimes(2);
    expect(Purchases.setAttributes).toHaveBeenLastCalledWith(expect.objectContaining({ server_tier: 'professional' }));
  });
});

describe('what starts it', () => {
  it('the tick runs it once, then not again until 15 minutes (jittered at most +20%) have passed', async () => {
    const billing = countBilling();
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    expect(billing.calls()).toBe(1);

    await settle(10 * MIN);
    expect(await jobRows(TASK)).toHaveLength(1);

    await settle(10 * MIN);
    expect((await jobRows(TASK)).length).toBeGreaterThanOrEqual(2);
  });

  it('is held back offline and signed out, and runs once both hold', async () => {
    useNetworkStore.setState({ isConnected: false });
    await initScheduler();
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    useNetworkStore.setState({ isConnected: true });
    useUserStore.setState({ userPersona: null });
    await settle(MIN);
    expect(await jobRows(TASK)).toHaveLength(0);

    seedLocalUser();
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
    expect(useSubscriptionStore.getState().serverTier).toBe('individual');
  });

  it('does not wait for the database: it carries no db-ready condition', async () => {
    useDatabaseStore.setState({ ready: false });

    await initScheduler();
    await settle(10_000);

    expect(await jobStatuses(TASK)).toEqual(['completed']);
  });

  it('a foreground return and a reconnect both re-run it once the 60s floor has passed', async () => {
    await initScheduler();
    await advanceUntil(() => lastRunInStore(TASK) !== null, 'the first run', 10_000);
    const first = (await jobRows(TASK)).length;

    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first); // inside the floor

    await settle(2 * MIN);
    setAppState('background');
    setAppState('active');
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first + 1);

    await settle(2 * MIN);
    useNetworkStore.setState({ isConnected: false });
    useNetworkStore.setState({ isConnected: true });
    await settle(500);
    expect(await jobRows(TASK)).toHaveLength(first + 2);
  });
});
