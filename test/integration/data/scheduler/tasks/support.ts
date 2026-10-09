// Shared by the scheduler task seam tests (data-U13). Not a test file.
//
// Each test file imports ONE real task module for its registration side effect, so the real
// AppScheduler singleton of that file holds exactly that task (a tick fires every registered real
// task, so two in one file would run each other's services). The handler runs through the real
// scheduler, runner, persistence and store; only the clock and AppState are faked.
import { invalidateJwtCache } from '@/lib/auth-client';
import { addFact } from '@/lib/database/services/fact-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import * as persistence from '@/lib/scheduler/scheduler-persistence';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import type { TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  advanceUntilDone,
  server,
  signInFixtureAccount,
  useStrictClock as freezeClockAt, // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
  type GatewayCall,
  type GatewayReply,
} from '@/test/helpers';

import { advanceUntil, jobRows, resetScheduler, settle } from '../core/support';

export { advanceUntil, jobRows, settle };

/** The fake "now" every test starts at. */
export const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * The definition a task module hands to `AppScheduler.register`, read through a call-through spy on a
 * fresh scheduler module (nothing private is read, and the real registration still runs).
 */
export function registeredDefinition(modulePath: string): TaskDefinition<unknown> {
  let definition: TaskDefinition<unknown> | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppScheduler: fresh } = require('@/lib/scheduler/AppScheduler') as typeof import('@/lib/scheduler/AppScheduler');
    const register = jest.spyOn(fresh, 'register');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(modulePath);
    expect(register).toHaveBeenCalledTimes(1);
    definition = register.mock.calls[0][0] as TaskDefinition<unknown>;
  });
  return definition as TaskDefinition<unknown>;
}

/** The condition types of a definition, in declared order. */
export const conditionTypes = (def: TaskDefinition<unknown>): string[] => (def.conditions ?? []).map((c) => c.type);

/**
 * Per-test start: a quiet scheduler on a strict fake clock at T0, the database ready, the failure
 * backoff of `taskName` forgotten (it survives `dispose()` and every test restarts at the same T0).
 * `signedIn` brings up the fixture account first, on real timers (MSW answers in real time).
 */
export async function startTest(taskName: string, opts: { signedIn?: boolean } = {}): Promise<void> {
  jest.useRealTimers();
  if (opts.signedIn) await signInFixtureAccount();
  freezeClockAt(T0);
  resetScheduler();
  AppScheduler.clearFailure(taskName);
  useDatabaseStore.setState({ ready: true });
}

export function endTest(): void {
  AppScheduler.dispose();
  stopRecording.splice(0).forEach((stop) => stop());
}

/** `AppScheduler.trigger` under the strict clock. */
export const runTask = (name: string, input?: unknown) => advanceUntilDone(AppScheduler.trigger(name, input));

/** `AppScheduler.init()` under the strict clock: loads the persisted last-run times and starts the 5s tick. */
export const initScheduler = () => advanceUntilDone(AppScheduler.init());

/** The in-memory last run the tick and the foreground read. */
export const lastRunInStore = (name: string): number | null => useSchedulerStore.getState().getLastRun(name);

/** The last run as persisted (`scheduler_last_run_<name>`), the copy a next session loads. */
export async function lastRunPersisted(name: string): Promise<number | null> {
  return (await persistence.loadLastRunTimes([name].values()))[name] ?? null;
}

/** Statuses of every persisted job of a task, oldest first. */
export async function jobStatuses(name: string): Promise<string[]> {
  return (await jobRows(name)).map((r) => r.status);
}

/** Stand-in for the one task `backgroundWorkIsIdle` defers to: `feed-sync`, held open until released. */
export function holdFeedSync() {
  const releases: (() => void)[] = [];
  AppScheduler.register({
    name: 'feed-sync',
    displayName: 'feed-sync (stand-in)',
    frequency: 0,
    handler: () => new Promise<void>((resolve) => releases.push(resolve)),
  });
  let run: Promise<unknown> | null = null;
  return {
    /** Starts the stand-in run; resolves once the scheduler store shows it running. */
    async start(): Promise<void> {
      run = AppScheduler.trigger('feed-sync');
      await advanceUntil(() => useSchedulerStore.getState().isRunning('feed-sync'), 'feed-sync to run', 5_000);
    },
    async release(): Promise<void> {
      releases.splice(0).forEach((r) => r());
      if (run) await advanceUntilDone(run);
      run = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The cloud call path and the model side (hygiene, sanity backfill, optimisation cycle)
// ---------------------------------------------------------------------------

/** Limiter spacing, fallback ladder, attestation and JWT caches, and the mode store. Call from `beforeEach`. */
export function resetCloudCallPath(): void {
  resetLimiter();
  resetModelFallback();
  __resetOnDeviceGateForTests();
  clearAttestationCache();
  invalidateJwtCache();
  useMeraProtocolStore.setState(useMeraProtocolStore.getInitialState(), true);
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
}

/** The mode the way the settings screen leaves it: the store AND the persisted row. */
export async function setMode(mode: 'cloud' | 'on-device'): Promise<void> {
  const value = mode === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice;
  useMeraProtocolStore.setState({ processingMode: value });
  await setSetting('mera_processing_mode', value);
}

/** The user message of a decrypted gateway call. */
export const userMessage = (call: GatewayCall): string => call.messages.find((m) => m.role === 'user')?.content ?? '';

/** `N. "text"` lines of a topic-sanity prompt, in the order the model sees them. */
export function sanityItems(call: GatewayCall): { n: number; text: string }[] {
  return [...userMessage(call).matchAll(/^(\d+)\. "(.*)"$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
}

/** A topic-sanity model: judges every numbered topic of the prompt, flagging the ones `isBad` names. */
export function sanityModel(isBad: (topicText: string) => boolean = (t) => /festival music tech/.test(t)) {
  return (call: GatewayCall): GatewayReply =>
    JSON.stringify(sanityItems(call).map((i) => ({ i: i.n, ok: !isBad(i.text) })));
}

/** A fact with one topic per text, written `stepMs` apart on the (fake) clock so each has its own `created_at`. */
export async function seedFactWithTopics(statement: string, texts: string[], stepMs = 10) {
  const fact = await addFact(statement);
  const start = Date.now();
  for (let i = 0; i < texts.length; i++) {
    jest.setSystemTime(start + i * stepMs);
    await createTopics([{ factId: fact.id, text: texts[i], weight: 0.75, provenance: 'llm', status: 'active' }]);
  }
  jest.setSystemTime(start);
  return fact;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** What the `authenticated` condition and the push-token check read: a persona and a user id in the user store. */
export function seedLocalUser(persona: Record<string, unknown> = {}, userId = 'user-1'): void {
  useUserStore.setState({ userId, userPersona: { _id: 'persona-1', ...persona } as never });
}

/** Every GraphQL operation the app sends from now on, with its variables. Stopped by `endTest()`. */
export function recordOps() {
  const sent: { op: string; variables: Record<string, any> }[] = [];
  const listener = ({ request }: { request: Request }) => {
    if (!request.url.endsWith('/graphql')) return;
    void request
      .clone()
      .json()
      .then((b: { operationName?: string; variables?: Record<string, any> }) => {
        if (b.operationName) sent.push({ op: b.operationName, variables: b.variables ?? {} });
      });
  };
  server.events.on('request:start', listener);
  stopRecording.push(() => server.events.removeListener('request:start', listener));
  return {
    /** Variables of every send of one operation, in order. */
    of: (op: string): Record<string, any>[] => sent.filter((s) => s.op === op).map((s) => s.variables),
  };
}
const stopRecording: (() => void)[] = [];

/** The `[task] message` lines handlers wrote through `ctx.log`, read from a spy on the real logger (an edge). */
export function captureTaskLogs(taskName: string): () => string[] {
  const spy = jest.spyOn(logger, 'info');
  const prefix = `[${taskName}] `;
  return () =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith(prefix))
      .map((m) => m.slice(prefix.length));
}

/** Stand-in for the `feed-sync` task that counts its runs (the end-of-pass refresh triggers it by name). */
export function registerFeedSyncCounter(): { runs: number } {
  const counter = { runs: 0 };
  AppScheduler.register({
    name: 'feed-sync',
    displayName: 'feed-sync (stand-in)',
    frequency: 0,
    handler: async () => {
      counter.runs += 1;
    },
  });
  return counter;
}
