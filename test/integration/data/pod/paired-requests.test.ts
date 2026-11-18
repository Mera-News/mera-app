// Every network request a phone makes while paired to its own server, recorded at the network edge.
// Only the server's routes and a short list of account operations may appear. Nothing reaches Mera's
// gateway, Mera's news queries or scoring. Assertion messages carry host classes and operation names only.
jest.mock('expo-task-manager', () => require('../background/native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('../background/native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import '@/lib/scheduler/tasks/feed-sync-task';
import '@/lib/scheduler/tasks/feedback-request-sync-task';
import '@/lib/scheduler/tasks/inference-recover-task';
import '@/lib/scheduler/tasks/apollo-cache-evict-task';
import '@/lib/scheduler/tasks/push-token-check-task';
import '@/lib/scheduler/tasks/data-cleanup-task';
import '@/lib/scheduler/tasks/persona-migration-task';
import '@/lib/scheduler/tasks/persona-hygiene-task';
import '@/lib/scheduler/tasks/sanity-backfill-task';
import '@/lib/scheduler/tasks/persona-geo-task';
import '@/lib/scheduler/tasks/feedback-cycle-task';
import '@/lib/scheduler/tasks/entitlement-sync-task';
import '@/lib/scheduler/tasks/fact-check-reconcile-task';

import { gql } from '@apollo/client';

import { clearFeedCacheAndResync } from '@/components/custom/config-mera/clear-feed-cache';
import client from '@/lib/apollo-client';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { runBackgroundRefresh } from '@/lib/background/background-task';
import { addFact } from '@/lib/database/services/fact-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { MERA_ONLY_OPERATIONS, NEWS_OPERATIONS } from '@/lib/own-services/news-operations';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { ALL_JOB_TYPES, enterPodMode, leavePodMode, syncPod, TASKS_PAUSED_WHILE_PAIRED } from '@/lib/own-services/pod-runner';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { platform } from '@/lib/platform';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { MARKS_TICK_MS } from '@/lib/sync/session';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { cleanupFeedSync, resetFeedSyncMemory } from '../feed-sync/steps/support';
import { resetScheduler } from '../scheduler/core/support';
import { seedLocalUser } from '../scheduler/tasks/support';
import { resetNativeTasks } from '../background/native-fakes';
import { wakeCleanup, wakeWorld } from '../background/support';
import {
  advanceUntil,
  advanceUntilDone,
  fakePod,
  initI18nEn,
  podPairing,
  podSnapshotFrom,
  server,
  setAppState,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import database from '@/lib/database';
import { http, HttpResponse } from 'msw';
import { reply, setWebSearchInChat, toolCall } from '@/test/integration/chat/_helpers';
import { attachCloud, turnDone } from '@/test/integration/chat/cloud-engine/kit';

jest.setTimeout(60_000);

const TOKEN = 'pod-token-abcdef123456';
const MERA_HOST = '127.0.0.1:8790';
const POD_HOST = 'pod.own.test';

/** Account operations a paired phone may still send to Mera, each with the reason it stays there. */
const ALLOWED_MERA_OPERATIONS: Record<string, string> = {
  GetUserBilling: 'what the person pays is an account fact Mera holds, and the pod knows nothing of it',
  GetUserBillingLapseState: 'the plan check (entitlement-sync): whether a paid plan lapsed',
  GetUserReading: 'the plan check: the daily reading the plan allows, shown on the plan screens',
  GetReadingPlans: 'the plan check: the plans on offer',
  GetPlanPromo: 'the plan check: an offer the server holds for this account',
  ActiveFeedbackRequests: 'questions Mera Labs asks this account (feedback-request-sync), an account feature',
  UpdateExpoPushToken: 'the push address for the account notifications Mera still sends (push-token-check)',
  SubmitFeedbackResponse: 'the person answers a question Mera Labs asked: the answer is the person\'s own text, sent on purpose',
  UpdateNotificationWindow: 'the person changes when account notifications may arrive',
  UpdateNotificationsEnabled: 'the person turns account notifications on or off',
  GetIntercomIdentity: 'the person opens support chat: the identity for the support service',
};

/** Account routes on Mera other than GraphQL, and why. */
const ALLOWED_MERA_PATHS: Record<string, string> = {
  '/api/auth/get-session': 'the sign-in check the account tasks run before they ask Mera anything',
  '/api/auth/token': 'the same sign-in check',
  '/api/auth/accept-legal': 'the person accepts a new terms or privacy version',
  '/api/auth/request-account-deletion': 'the person asks to delete the account',
  '/api/auth/sign-out': 'the person logs out',
};

/** The routes of the paired server a phone may call, and why. */
const ALLOWED_POD_PATHS: Record<string, string> = {
  '/snapshot': 'the sync pulls the rows the server holds',
  '/commands': 'a change to shared rows runs on the server, and the sync that follows rides on it',
  '/graphql': 'news queries go to the server, news operations only',
  '/v1/chat/completions': 'model calls go to the server',
};

type Klass = 'pod' | 'mera' | 'gateway' | 'other';
interface Seen {
  klass: Klass;
  method: string;
  name: string;
  /** Every header value, joined: checked for the pod's token and address on Mera's requests. */
  headers: string;
  /** The request body as text, read for content that must never reach Mera. */
  body: string;
}
const label = (s: Seen) => `${s.klass} ${s.method} ${s.name}`;

/** Every request MSW sees from now on, by host class and operation name. */
function record() {
  const seen: Seen[] = [];
  const pending: Promise<unknown>[] = [];
  const listener = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const klass: Klass =
      url.host === POD_HOST
        ? 'pod'
        : url.host !== MERA_HOST
          ? 'other'
          : url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/attestation')
            ? 'gateway'
            : 'mera';
    const headers: string[] = [];
    request.headers.forEach((v, k) => headers.push(`${k}: ${v}`));
    const entry: Seen = { klass, method: request.method, name: url.pathname, headers: headers.join('\n'), body: '' };
    seen.push(entry);
    pending.push(
      request
        .clone()
        .text()
        .then((t) => {
          entry.body = t;
        })
        .catch(() => undefined),
    );
    if (url.pathname.endsWith('/graphql')) {
      pending.push(
        request
          .clone()
          .json()
          .then((b: { operationName?: string }) => {
            entry.name = `graphql ${b.operationName ?? ''}`;
          })
          .catch(() => undefined),
      );
    }
  };
  server.events.on('request:start', listener);
  return {
    stop: async () => {
      server.events.removeListener('request:start', listener);
      await Promise.all(pending);
      return seen;
    },
  };
}

const isGraphql = (s: Seen) => s.name.startsWith('graphql ');
const operationOf = (s: Seen) => s.name.slice('graphql '.length);

function isAllowed(s: Seen): boolean {
  if (s.klass === 'pod') {
    if (isGraphql(s)) return NEWS_OPERATIONS.has(operationOf(s));
    return s.name in ALLOWED_POD_PATHS;
  }
  if (s.klass === 'mera') return isGraphql(s) ? operationOf(s) in ALLOWED_MERA_OPERATIONS : s.name in ALLOWED_MERA_PATHS;
  return false;
}

let pod: ReturnType<typeof fakePod>;
const table: Record<string, string[]> = {};
/** The pod's token and address, a fact the pod served, a chat line and an article the person opened. */
const CONTENT_NEVER_TO_MERA = [TOKEN, POD_HOST, 'Lives in Utrecht', 'CHAT-LINE-NEVER-TO-MERA', 'opened-article-1'];

/** Checks one situation: only allowed requests, nothing for the gateway or a Mera news query, and the pod's rules. */
async function census(situation: string, rec: ReturnType<typeof record>, expected: string[]) {
  const seen = await rec.stop();
  expect(seen.filter((s) => !isAllowed(s)).map(label)).toEqual([]);
  expect(seen.filter((s) => s.klass === 'gateway').map(label)).toEqual([]);
  const meraNews = seen.filter((s) => s.klass === 'mera' && isGraphql(s) && (NEWS_OPERATIONS.has(operationOf(s)) || MERA_ONLY_OPERATIONS.has(operationOf(s))));
  expect(meraNews.map(label)).toEqual([]);
  // The reverse: nothing of the pod, and no profile, chat or reading content, rides on a request to Mera.
  const leaks = seen
    .filter((s) => s.klass !== 'pod' && CONTENT_NEVER_TO_MERA.some((c) => s.headers.includes(c) || s.body.includes(c)))
    .map(label);
  expect(leaks).toEqual([]);
  for (const r of pod.requests) {
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    for (const h of ['cookie', 'x-mera-client', 'x-api-key']) expect(r.headers[h]).toBeUndefined();
  }
  table[situation] = [...new Set(seen.map(label))].sort();
  expect(table[situation]).toEqual(expected);
}

const NEWS = gql`
  query GetArticleIdsForPersona($query: PersonaQueryInput!) {
    articleIdsForPersona(query: $query) {
      topicResults {
        topicText
        articleIds
      }
    }
  }
`;
const ACCOUNT = gql`
  query GetUserBilling {
    userBilling {
      __typename
    }
  }
`;
const FACT_CHECK = gql`
  query GetFactCheck($articleId: ID!) {
    factCheck(articleId: $articleId) {
      __typename
    }
  }
`;
const noCache = { fetchPolicy: 'no-cache' as const };
const podFact = (id: string) => watermelonRowSink.createRows('facts', [{ id, statement: 'Lives in Utrecht', created_at: 1, updated_at: 1 }]);
const realTurn = () => new Promise<void>((r) => setImmediate(r));
const hasSnapshot = () => pod.requests.some((r) => r.path === '/snapshot');

describe('while paired', () => {
  beforeEach(async () => {
    await initI18nEn();
    resetScheduler();
    resetBreaker();
    resetFeedSyncMemory();
    resetPodHealth();
    podState.resetMemory();
    setAppState('active');
    pod = fakePod({ token: TOKEN });
    pod.graphql.GetArticleIdsForPersona = { articleIdsForPersona: { __typename: 'PersonaArticleIds', topicResults: [] } };
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await signInFixtureAccount();
    await savePairing(podPairing({ token: TOKEN }));
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    await leavePodMode();
    await forgetPairing();
    await inferenceQueue.stop();
    for (const t of ALL_JOB_TYPES) __setJobHandlerForTests(t, undefined);
    AppScheduler.dispose();
    cleanupFeedSync();
    jest.restoreAllMocks();
  });

  it('a boot: the first kick syncs with the server and nothing else leaves the phone but the account checks', async () => {
    podState.resetMemory();
    useDatabaseStore.setState({ ready: true });
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    const rec = record();

    await platform('paired-requests').hydrateHostState!();
    const init = AppScheduler.init();
    await jest.advanceTimersByTimeAsync(100);
    await init;
    AppScheduler.onStoresHydrated();
    await advanceUntil(hasSnapshot, 20_000);
    await jest.advanceTimersByTimeAsync(60_000);

    await census('boot', rec, ['pod POST /snapshot']);
  });

  it('a foreground and a sync', async () => {
    await enterPodMode();
    const rec = record();

    await syncPod();
    setAppState('background');
    setAppState('active');
    await AppScheduler.trigger('feed-sync', undefined, { bypassDebounce: true });
    await realTurn();

    await census('foreground and sync', rec, ['pod POST /snapshot']);
  });

  it('commands: a writer, the marks and a resync', async () => {
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    await enterPodMode();
    await syncPod();
    const rec = record();

    await addFact('I follow cycling');
    await recordOpen({ articleId: 'a1', surface: 'feed' });
    await jest.advanceTimersByTimeAsync(MARKS_TICK_MS);
    await advanceUntil(() => pod.requests.some((r) => r.path === '/commands' && r.body.commands[0].name === 'marks'), 10_000);
    await clearFeedCacheAndResync();

    await census('commands', rec, ['pod POST /commands', 'pod POST /snapshot'].sort());
    const names = pod.requests.filter((r) => r.path === '/commands').flatMap((r) => r.body.commands.map((c: { name: string }) => c.name));
    expect(names).toEqual(expect.arrayContaining(['addFact', 'marks', 'resync']));
  });

  it('a chat turn goes to the server and nothing else', async () => {
    await enterPodMode();
    const rec = record();

    for await (const e of cloudChatStream({ messages: [{ role: 'user', content: 'hi' }], route: 'topics', enableThinking: false })) void e;

    await census('chat turn', rec, ['pod POST /v1/chat/completions']);
  });

  it('a whole chat turn, with web search on and the model asking for it, sends every leg to the server', async () => {
    await setWebSearchInChat(true);
    await enterPodMode();
    // The server's model asks for a web search on its first leg and answers on the next.
    let legs = 0;
    const answer = (text: string, stream: boolean) => {
      if (!stream) return HttpResponse.json({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      return new HttpResponse(chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    server.use(
      http.post(`https://${POD_HOST}/v1/chat/completions`, async ({ request }) => {
        const body = (await request.clone().json()) as { stream?: boolean };
        legs += 1;
        pod.requests.push({ path: '/v1/chat/completions', headers: Object.fromEntries(request.headers.entries()), body });
        const text = legs === 1 ? reply('Let me look.', toolCall('webSearch', { queries: ['utrecht news'] })) : 'Here is what I found.';
        return answer(text, body.stream !== false);
      }),
    );
    const rec = record();

    const { engine } = await attachCloud();
    void engine.send('What is new in Utrecht?');
    await turnDone();

    // The model asked for a search; the turn went on to a second leg, also to the server.
    expect(legs).toBeGreaterThanOrEqual(2);
    await census('chat session turn', rec, ['pod POST /v1/chat/completions']);
  });

  it('a news query goes to the server, an account query to Mera, a fact check nowhere', async () => {
    await enterPodMode();
    const rec = record();

    await client.query({ query: NEWS, variables: { query: { topics: [] } }, ...noCache });
    await client.query({ query: ACCOUNT, ...noCache });
    const before = pod.requests.length;
    const factCheck = await client.query({ query: FACT_CHECK, variables: { articleId: 'a1' }, ...noCache }).then(
      () => null,
      (e: { errors?: { extensions?: { code?: string } }[] }) => e.errors?.[0]?.extensions?.code,
    );

    expect(factCheck).toBe('NOT_OFFERED');
    expect(pod.requests).toHaveLength(before);
    await census('queries', rec, ['mera POST graphql GetUserBilling', 'pod POST graphql GetArticleIdsForPersona']);
  });

  it('a simulated day on the scheduler: paused tasks stay quiet and the rest ask only the server or the account', async () => {
    useDatabaseStore.setState({ ready: true });
    seedLocalUser();
    useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
    // Recorded from the start, so a task that should not run is named by what it sends.
    const rec = record();
    await platform('paired-requests').hydrateHostState!();
    const init = AppScheduler.init();
    await jest.advanceTimersByTimeAsync(100);
    await init;
    AppScheduler.onStoresHydrated();
    await jest.advanceTimersByTimeAsync(20_000);
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(AppScheduler.isPaused(name)).toBe(true);

    for (let hour = 1; hour <= 24; hour++) {
      await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
      if (hour % 6 === 0) {
        setAppState('background');
        useNetworkStore.setState({ isConnected: false });
        await jest.advanceTimersByTimeAsync(1000);
        useNetworkStore.setState({ isConnected: true });
        setAppState('active');
        await jest.advanceTimersByTimeAsync(1000);
      }
    }

    // The account tasks run and ask only account questions; the reading tasks stay paused.
    const ran = new Set((await database.get('scheduler_jobs').query().fetch()).map((r) => (r._raw as unknown as { task_name: string }).task_name));
    for (const name of ['entitlement-sync', 'push-token-check', 'feedback-request-sync']) expect(ran.has(name)).toBe(true);
    for (const name of TASKS_PAUSED_WHILE_PAIRED) expect(ran.has(name)).toBe(false);
    await census(
      'simulated day',
      rec,
      [
        'mera GET /api/auth/get-session',
        'mera GET /api/auth/token',
        'mera POST graphql ActiveFeedbackRequests',
        'mera POST graphql GetPlanPromo',
        'mera POST graphql GetReadingPlans',
        'mera POST graphql GetUserBilling',
        'mera POST graphql GetUserBillingLapseState',
        'mera POST graphql GetUserReading',
        'mera POST graphql UpdateExpoPushToken',
        'pod POST /snapshot',
      ],
    );
    expect(pod.requests.filter((r) => r.path === '/snapshot').length).toBeGreaterThan(2);
  });
});

describe('an OS wake while paired', () => {
  beforeEach(async () => {
    resetNativeTasks();
    podState.resetMemory();
    resetPodHealth();
    await wakeWorld();
  });
  afterEach(async () => {
    await wakeCleanup();
    podState.resetMemory();
    await forgetPairing();
  });

  it('syncs with the server and nothing else', async () => {
    pod = fakePod({ token: TOKEN });
    await savePairing(podPairing({ token: TOKEN }));
    podState.resetMemory();
    const rec = record();

    await advanceUntilDone(runBackgroundRefresh());

    await census('wake', rec, ['pod POST /snapshot']);
  });
});

// Last in the file: logging out signs the session out, and nothing may run after it.
describe('when the person does something while paired', () => {
  beforeEach(async () => {
    await initI18nEn();
    resetScheduler();
    resetBreaker();
    resetPodHealth();
    podState.resetMemory();
    setAppState('active');
    pod = fakePod({ token: TOKEN });
    pod.snapshot = await podSnapshotFrom(() => podFact('pod-fact-1'));
    await signInFixtureAccount();
    seedLocalUser();
    await savePairing(podPairing({ token: TOKEN }));
    await enterPodMode();
    await syncPod();
    // Content that lives on the phone: a chat line and an opened article.
    await watermelonRowSink.createRows('messages', [{ id: 'm1', conversation_id: 'c1', role: 'user', content: 'CHAT-LINE-NEVER-TO-MERA', created_at: 1 }]);
    await recordOpen({ articleId: 'opened-article-1', surface: 'feed' });
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(async () => {
    await leavePodMode();
    await forgetPairing();
    AppScheduler.dispose();
    jest.restoreAllMocks();
  });

  it('accepts a new terms and privacy version', async () => {
    const rec = record();
    const { acceptLegal } = await import('@/components/custom/auth/legal-consent');
    expect((await acceptLegal({ termsVersion: 't2', privacyVersion: 'p2' })).ok).toBe(true);
    await census('person: accepts the terms', rec, ['mera POST /api/auth/accept-legal']);
  });

  it('answers a feedback question', async () => {
    const rec = record();
    const { submitFeedbackResponse } = await import('@/lib/feedback-requests/feedback-request-service');
    await submitFeedbackResponse('fr-1', 'The feed is good');
    await census('person: answers a question', rec, ['mera POST graphql SubmitFeedbackResponse']);
  });

  it('opens the plan page', async () => {
    const rec = record();
    const { fetchReadingPlans } = await import('@/lib/subscription/reading-plans');
    const { syncPlanPromo } = await import('@/lib/subscription/plan-promo');
    await fetchReadingPlans();
    await syncPlanPromo();
    await census('person: opens the plan page', rec, ['mera POST graphql GetPlanPromo', 'mera POST graphql GetReadingPlans']);
  });

  it('changes notification settings', async () => {
    const rec = record();
    const { AccountService } = await import('@/lib/account-service');
    await AccountService.updateNotificationPreferences('user-1', [8, 20]).catch(() => undefined);
    await AccountService.updateNotificationsEnabled('user-1', true).catch(() => undefined);
    await census('person: notification settings', rec, ['mera POST graphql UpdateNotificationWindow', 'mera POST graphql UpdateNotificationsEnabled']);
  });

  it('asks to delete the account (the same call the delete dialog makes)', async () => {
    const rec = record();
    const { authClient } = await import('@/lib/auth-client');
    await authClient.$fetch('/request-account-deletion', { method: 'POST' }).catch(() => undefined);
    await census('person: deletes the account', rec, ['mera POST /api/auth/request-account-deletion']);
  });

  const logOut = async () => {
    const rec = record();
    const { signOutAndWipe } = await import('@/lib/security/local-wipe');
    await signOutAndWipe();
    await new Promise<void>((r) => setImmediate(r));
    return rec.stop();
  };

  it('logs out: Mera gets the sign-out and nothing of the pod or of the person\'s content', async () => {
    const seen = await logOut();
    const mera = [...new Set(seen.filter((s) => s.klass !== 'pod').map(label))].sort();
    table['person: logs out'] = [...new Set(seen.map(label))].sort();
    expect(mera).toEqual(['mera GET /api/auth/get-session', 'mera POST /api/auth/sign-out']);
    for (const s of seen.filter((x) => x.klass !== 'pod')) for (const c of CONTENT_NEVER_TO_MERA) expect(s.headers + s.body).not.toContain(c);
    expect(pod.requests.some((r) => r.path === '/devices/revoke')).toBe(true);
  });

  // Known, reported: logging out resets the Mera Protocol store while the sink is still set, and its
  // deleteSetting('mera_skip_notes') goes to the server as a command, after the revoke. It flips to a
  // pass once logout leaves pod mode before the stores reset.
  it.failing('logs out: the server gets the revoke and nothing else', async () => {
    await logOut();
    expect(pod.requests.filter((r) => r.path !== '/devices/revoke' && r.path !== '/snapshot')).toEqual([]);
  });
});
