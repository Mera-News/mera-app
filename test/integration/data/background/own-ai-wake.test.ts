// The OS wake and the silent-push task when the person's own AI service is on: that transport serves no
// async jobs, so a wake fetches and persists, and nothing reaches Mera's gateway.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import * as TaskManager from 'expo-task-manager';
import { INFERENCE_TASK, defineInferenceTask } from '@/lib/background/inference-task';
import { runBackgroundWake } from '@/lib/background/background-task';
import { OWN_AI_KEY } from '@/lib/own-services/keys';
import { ownAiState, type OwnAiConfig } from '@/lib/own-services/own-ai-state';
import { advanceUntilDone, failSecureStore, gatewayCalls, healSecureStore, http, HttpResponse, secureStoreDump, server } from '@/test/helpers';
import { runBackgroundRefresh } from '@/lib/background/background-task';
import { ownNewsState, type OwnNewsConfig } from '@/lib/own-services/own-news-state';
import { drive, ids, resetCycleWorld, submitJobs, watchResultsGets, gatewayPolls } from '@/test/integration/chat/jobs/support';

import { resetNativeTasks } from './native-fakes';
import { rowsById, serveFresh, wakeCleanup, wakeWorld } from './support';

jest.setTimeout(60_000);

const OWN: OwnAiConfig = {
  v: 1, baseUrl: 'https://ai.own.test/v1', model: 'own-model', key: 'own-ai-key-12345678', on: true, checkedAt: 1, status: 'connected', confirmed: { at: 1, privacyVersion: null },
};

// Stored but not in memory: the wake has to read it itself before any request.
async function ownAiOnButUnread() {
  ownAiState.resetMemory();
  await ownAiState.save(OWN);
  ownAiState.resetMemory();
  expect(Object.keys(secureStoreDump())).toContain(OWN_AI_KEY);
}

describe('a wake', () => {
  beforeEach(async () => {
    resetNativeTasks();
    ownAiState.resetMemory();
    await wakeWorld();
  });
  afterEach(async () => {
    await wakeCleanup();
    ownAiState.resetMemory();
  });

  it('with own AI on: no request to the gateway, no job, fetched rows persisted unscored', async () => {
    const { fresh } = await serveFresh(3);
    await ownAiOnButUnread();

    await advanceUntilDone(runBackgroundWake());

    expect(gatewayCalls()).toEqual([]);
    const rows = await rowsById();
    expect([...rows.keys()].sort()).toEqual([...fresh].sort());
    for (const row of rows.values()) expect(row.relevance ?? 0).toBe(0);
  });

  it('with own news on: the wake asks the own server for news, with no Mera cookie, and Mera gets no news query', async () => {
    await serveFresh(3);
    const NEWS: OwnNewsConfig = {
      v: 1, baseUrl: 'https://news.own.test', key: 'own-news-key-12345678', on: true, checkedAt: 1, status: 'connected', fields: null, confirmed: { at: 1, privacyVersion: null },
    };
    ownNewsState.resetMemory();
    await ownNewsState.save(NEWS);
    ownNewsState.resetMemory();
    const seen: { host: string; op: string; cookie: string | null }[] = [];
    const pending: Promise<unknown>[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method !== 'POST' || !request.url.endsWith('/graphql')) return;
      const entry = { host: new URL(request.url).host, op: '', cookie: request.headers.get('cookie') };
      seen.push(entry);
      pending.push(request.clone().json().then((b: { operationName?: string }) => { entry.op = b.operationName ?? ''; }, () => undefined));
    };
    server.events.on('request:start', listener);
    // The own server is down: the wake must still send nothing about news to Mera.
    server.use(http.post('https://news.own.test/graphql', () => new HttpResponse('down', { status: 503 })));
    try {
      await advanceUntilDone(runBackgroundWake());
      await Promise.all(pending);
    } finally {
      server.events.removeListener('request:start', listener);
      ownNewsState.resetMemory();
    }
    const own = seen.filter((x) => x.host === 'news.own.test');
    expect(own.map((x) => x.op)).toContain('GetArticleIdsForPersona');
    expect(own.every((x) => x.cookie === null)).toBe(true);
    const { NEWS_OPERATIONS } = require('@/lib/own-services/news-operations') as typeof import('@/lib/own-services/news-operations');
    expect(seen.filter((x) => x.host !== 'news.own.test' && NEWS_OPERATIONS.has(x.op))).toEqual([]);
  });

  it('a keychain that cannot be read ends the wake quietly, with no request anywhere', async () => {
    await serveFresh(3);
    await ownAiOnButUnread();
    failSecureStore(OWN_AI_KEY, 'get');
    try {
      const out = await advanceUntilDone(runBackgroundRefresh());
      expect(out.stoppedBy).toBe('locked');
      expect(gatewayCalls()).toEqual([]);
      expect(await rowsById()).toEqual(new Map());
    } finally {
      healSecureStore();
    }
  });

  it('with own AI off: the bounded submit still reaches the gateway', async () => {
    await serveFresh(3);
    await ownAiState.hydrate();

    await advanceUntilDone(runBackgroundWake());

    expect(gatewayCalls('job').length).toBeGreaterThan(0);
  });
});

describe('a silent push', () => {
  defineInferenceTask();
  const body = (TaskManager.defineTask as jest.Mock).mock.calls.find((c) => c[0] === INFERENCE_TASK)![1] as (b: unknown) => Promise<unknown>;

  beforeEach(async () => {
    ownAiState.resetMemory();
    await resetCycleWorld();
  });
  afterEach(() => ownAiState.resetMemory());

  it('with own AI on: no gateway result fetch', async () => {
    const [, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    await ownAiOnButUnread();
    const gets = watchResultsGets();

    await drive(body({ data: { data: { type: 'inference-done', requestId: second } } }));

    expect(gets).toEqual([]);
  });

  it('with own AI off: the named job is fetched', async () => {
    const [, second] = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    const gets = watchResultsGets();

    await drive(body({ data: { data: { type: 'inference-done', requestId: second } } }));

    expect(gets.map((g) => g.id)).toEqual([second]);
  });
});
