// useUserStore against the real DB services, the real Apollo client and MSW
// (GetUserPersona is served by the default handlers). Replaces
// lib/stores/__tests__/user-store.test.ts.
import database from '@/lib/database';
import { loadUserPersona, persistUserPersona } from '@/lib/database/services/user-persona-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useUserStore } from '@/lib/stores/user-store';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';
import type { UserPersona } from '@/lib/account-service';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import {
  advanceUntilDone,
  graphql,
  HttpResponse,
  mockGql,
  mockGqlError,
  server,
  useFakeClock as freezeClockAt,
} from '@/test/helpers';
import { failSettingRead, failTableQuery, flush, restoreFaults, until } from './support';

function makePersona(overrides: Partial<UserPersona> = {}): UserPersona {
  return {
    _id: 'persona-1',
    userId: 'user-1',
    preferredNotificationWindow: [9, 18],
    notificationsEnabled: true,
    expoPushToken: null,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    language_codes: null,
    processingMode: ProcessingMode.Cloud,
    llmWarningCount: 0,
    lastSuccessfulCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-02T00:00:00Z').toISOString(),
    ...overrides,
  };
}

/** Serves GetUserPersona and records the user ids asked for. `answer` defaults to the mock backend's persona. */
const asked: string[] = [];
function servePersona(answer: (userId: string) => UserPersona | null = (userId) => personaFor(Date.now(), { userId })) {
  server.use(
    mockGql('GetUserPersona', (v) => {
      asked.push(String(v.userId));
      return { userPersonaByUserId: answer(String(v.userId)) };
    }),
  );
}

/** Like servePersona, but each response waits for `release()`. */
function servePersonaHeld(answer: (userId: string) => UserPersona | null = (userId) => personaFor(Date.now(), { userId })) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  server.use(
    graphql.query('GetUserPersona', async ({ variables }) => {
      asked.push(String(variables.userId));
      await gate;
      return HttpResponse.json({ data: { userPersonaByUserId: answer(String(variables.userId)) } });
    }),
  );
  return release;
}

const personaRowCount = () => database.get('user_personas').query().fetchCount();

beforeEach(() => {
  asked.length = 0;
  useUserStore.setState(useUserStore.getInitialState(), true);
});

afterEach(async () => {
  jest.useRealTimers();
  restoreFaults();
  // setUserId, setUserPersona, clearUser and the persona persist are fire-and-forget.
  await flush();
});

describe('initial state', () => {
  it('starts with no user, no persona, not loading, never fetched', () => {
    expect(useUserStore.getState()).toMatchObject({
      userId: null,
      userPersona: null,
      isLoading: false,
      lastFetchedAt: null,
    });
  });
});

describe('setUserId', () => {
  it('sets the id and persists it as cached_user_id', async () => {
    useUserStore.getState().setUserId('user-abc');
    expect(useUserStore.getState().userId).toBe('user-abc');
    await flush();
    expect(await getSetting('cached_user_id')).toBe('user-abc');
  });

  it('with null clears the id and deletes the cached_user_id row', async () => {
    await setSetting('cached_user_id', 'user-abc');
    useUserStore.getState().setUserId('user-abc');
    useUserStore.getState().setUserId(null);
    expect(useUserStore.getState().userId).toBeNull();
    await flush();
    expect(await getSetting('cached_user_id')).toBeNull();
  });

  it('keeps the id in memory when the write fails', async () => {
    failSettingRead('cached_user_id');
    useUserStore.getState().setUserId('user-xyz');
    await flush();
    expect(useUserStore.getState().userId).toBe('user-xyz');
    restoreFaults();
    expect(await getSetting('cached_user_id')).toBeNull();
  });

  it('keeps the cleared id when the delete fails', async () => {
    await setSetting('cached_user_id', 'user-abc');
    failSettingRead('cached_user_id');
    useUserStore.getState().setUserId(null);
    await flush();
    expect(useUserStore.getState().userId).toBeNull();
  });
});

describe('setUserPersona', () => {
  it('stores the persona, stamps lastFetchedAt and persists it for the current user', async () => {
    const before = Date.now();
    const persona = makePersona();
    useUserStore.setState({ userId: 'user-1' });
    useUserStore.getState().setUserPersona(persona);

    const state = useUserStore.getState();
    expect(state.userPersona).toEqual(persona);
    expect(state.lastFetchedAt).toBeGreaterThanOrEqual(before);

    await flush();
    expect(await loadUserPersona('user-1')).toMatchObject({ _id: 'persona-1', userId: 'user-1', notificationsEnabled: true });
  });

  it('does not persist without a userId', async () => {
    useUserStore.getState().setUserPersona(makePersona());
    await flush();
    expect(useUserStore.getState().userPersona).not.toBeNull();
    expect(await personaRowCount()).toBe(0);
  });

  it('does not persist a null persona, and leaves the stored one alone', async () => {
    await persistUserPersona('user-1', makePersona());
    useUserStore.setState({ userId: 'user-1' });
    useUserStore.getState().setUserPersona(null);
    await flush();
    expect(useUserStore.getState().userPersona).toBeNull();
    expect(await personaRowCount()).toBe(1);
  });

  it('keeps the persona in memory when the persist fails', async () => {
    failTableQuery('user_personas');
    useUserStore.setState({ userId: 'user-1' });
    useUserStore.getState().setUserPersona(makePersona());
    await flush();
    expect(useUserStore.getState().userPersona).not.toBeNull();
  });
});

describe('fetchUserPersona', () => {
  it('returns null for an empty userId without asking the server', async () => {
    servePersona();
    await expect(useUserStore.getState().fetchUserPersona('')).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it('fetches the persona, updates the store and persists it', async () => {
    servePersona(() => makePersona());
    const result = await useUserStore.getState().fetchUserPersona('user-1');

    expect(asked).toEqual(['user-1']);
    expect(result).toMatchObject({ _id: 'persona-1', userId: 'user-1' });
    const state = useUserStore.getState();
    expect(state.userId).toBe('user-1');
    expect(state.userPersona).toMatchObject({ _id: 'persona-1' });
    expect(state.isLoading).toBe(false);
    expect(state.lastFetchedAt).not.toBeNull();

    await flush();
    expect(await loadUserPersona('user-1')).toMatchObject({ _id: 'persona-1' });
  });

  it('serves a fresh cache for 5 minutes, then asks the server again', async () => {
    servePersona();
    freezeClockAt('2026-06-01T12:00:00Z');
    await advanceUntilDone(useUserStore.getState().fetchUserPersona('user-1'));
    expect(asked).toEqual(['user-1']);

    jest.setSystemTime(new Date('2026-06-01T12:04:59Z'));
    await advanceUntilDone(useUserStore.getState().fetchUserPersona('user-1'));
    expect(asked).toEqual(['user-1']);

    jest.setSystemTime(new Date('2026-06-01T12:05:01Z'));
    await advanceUntilDone(useUserStore.getState().fetchUserPersona('user-1'));
    expect(asked).toEqual(['user-1', 'user-1']);
  });

  it('bypasses the cache with force=true', async () => {
    servePersona();
    await useUserStore.getState().fetchUserPersona('user-1');
    await useUserStore.getState().fetchUserPersona('user-1');
    expect(asked).toEqual(['user-1']);
    await useUserStore.getState().fetchUserPersona('user-1', true);
    expect(asked).toEqual(['user-1', 'user-1']);
  });

  it('does not serve one user\'s fresh cache to another user', async () => {
    servePersona();
    await useUserStore.getState().fetchUserPersona('user-1');
    const second = await useUserStore.getState().fetchUserPersona('user-2');
    expect(asked).toEqual(['user-1', 'user-2']);
    expect(second).toMatchObject({ userId: 'user-2' });
  });

  it('dedupes a second call for the same user while the first is in flight, returning the current persona', async () => {
    const stale = makePersona({ _id: 'stale' });
    useUserStore.setState({ userId: 'user-1', userPersona: stale });
    const release = servePersonaHeld(() => makePersona({ _id: 'fresh' }));

    const first = useUserStore.getState().fetchUserPersona('user-1');
    await until(() => useUserStore.getState().isLoading, 'the fetch to start');
    const second = await useUserStore.getState().fetchUserPersona('user-1');

    expect(second).toMatchObject({ _id: 'stale' });
    release();
    await expect(first).resolves.toMatchObject({ _id: 'fresh' });
    expect(asked).toEqual(['user-1']);
  });

  it('does not dedupe a call for another user while one is in flight', async () => {
    const release = servePersonaHeld((userId) => (userId === 'user-2' ? null : makePersona()));

    const first = useUserStore.getState().fetchUserPersona('user-1');
    await until(() => useUserStore.getState().isLoading, 'the fetch to start');
    const second = useUserStore.getState().fetchUserPersona('user-2');
    await until(() => asked.length === 2, 'the second request');
    release();

    await expect(second).resolves.toBeNull();
    await first;
    expect(asked).toEqual(['user-1', 'user-2']);
  });

  it('handles a null persona from the server: nothing persisted, not loading', async () => {
    servePersona(() => null);
    const result = await useUserStore.getState().fetchUserPersona('user-1');
    expect(result).toBeNull();
    expect(useUserStore.getState()).toMatchObject({ userPersona: null, isLoading: false });
    await flush();
    expect(await personaRowCount()).toBe(0);
  });

  it('returns null on a server error and stops loading', async () => {
    server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR'));
    const result = await useUserStore.getState().fetchUserPersona('user-1');
    expect(result).toBeNull();
    expect(useUserStore.getState().isLoading).toBe(false);
  });
});

describe('fetchUserPersonaOrThrow', () => {
  it('returns null for an empty userId (not an error)', async () => {
    servePersona();
    await expect(useUserStore.getState().fetchUserPersonaOrThrow('')).resolves.toBeNull();
    expect(asked).toEqual([]);
  });

  it('fetches, updates the store and persists on success', async () => {
    servePersona(() => makePersona());
    const result = await useUserStore.getState().fetchUserPersonaOrThrow('user-1');
    expect(result).toMatchObject({ _id: 'persona-1' });
    const state = useUserStore.getState();
    expect(state.userPersona).toMatchObject({ _id: 'persona-1' });
    expect(state.isLoading).toBe(false);
    expect(state.lastFetchedAt).not.toBeNull();
    await flush();
    expect(await loadUserPersona('user-1')).toMatchObject({ _id: 'persona-1' });
  });

  it('returns the cached persona within 5 minutes without a request, and force bypasses it', async () => {
    servePersona();
    await useUserStore.getState().fetchUserPersonaOrThrow('user-1');
    await useUserStore.getState().fetchUserPersonaOrThrow('user-1');
    expect(asked).toEqual(['user-1']);
    await useUserStore.getState().fetchUserPersonaOrThrow('user-1', true);
    expect(asked).toEqual(['user-1', 'user-1']);
  });

  it('rethrows a server error (unlike fetchUserPersona) and stops loading', async () => {
    server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR', { message: 'persona unavailable' }));
    await expect(useUserStore.getState().fetchUserPersonaOrThrow('user-1')).rejects.toThrow('persona unavailable');
    expect(useUserStore.getState().isLoading).toBe(false);
  });
});

describe('clearUser', () => {
  async function seedSignedInUser() {
    await setSetting('cached_user_id', 'user-1');
    await setSetting('cached_user_email', 'reader@example.com');
    await setSetting('needs_reauth', '1');
    await persistUserPersona('user-1', makePersona());
    useUserStore.setState({
      userId: 'user-1',
      userEmail: 'reader@example.com',
      userPersona: makePersona(),
      isLoading: true,
      lastFetchedAt: Date.now(),
      needsReauth: true,
    });
  }

  it('resets every field and removes the cached identity and persona rows', async () => {
    await seedSignedInUser();
    useUserStore.getState().clearUser();

    expect(useUserStore.getState()).toMatchObject({
      userId: null,
      userEmail: null,
      userPersona: null,
      isLoading: false,
      lastFetchedAt: null,
      needsReauth: false,
    });
    await flush();
    expect(await personaRowCount()).toBe(0);
    expect(await getSetting('cached_user_id')).toBeNull();
    expect(await getSetting('cached_user_email')).toBeNull();
    expect(await getSetting('needs_reauth')).toBeNull();
  });

  it('still resets memory when the persona delete and the setting deletes fail', async () => {
    await seedSignedInUser();
    failTableQuery('user_personas');
    failSettingRead('cached_user_id');
    failSettingRead('cached_user_email');
    failSettingRead('needs_reauth');

    useUserStore.getState().clearUser();
    await flush();

    expect(useUserStore.getState()).toMatchObject({ userId: null, userPersona: null, needsReauth: false });
  });
});

describe('hydrateFromDb', () => {
  it('does nothing without a cached_user_id, even when a persona row exists', async () => {
    await persistUserPersona('user-9', makePersona({ userId: 'user-9' }));
    await useUserStore.getState().hydrateFromDb();
    expect(useUserStore.getState()).toMatchObject({ userId: null, userPersona: null });
  });

  it('sets only the userId when there is no persona row', async () => {
    await setSetting('cached_user_id', 'user-99');
    await useUserStore.getState().hydrateFromDb();
    expect(useUserStore.getState()).toMatchObject({ userId: 'user-99', userPersona: null });
  });

  it('sets the userId and the persona from the database, and forces a refetch on next access', async () => {
    await setSetting('cached_user_id', 'user-42');
    await persistUserPersona('user-42', makePersona({ userId: 'user-42', notificationsEnabled: false }));
    useUserStore.setState({ lastFetchedAt: 999 });

    await useUserStore.getState().hydrateFromDb();

    const state = useUserStore.getState();
    expect(state.userId).toBe('user-42');
    expect(state.userPersona).toMatchObject({ _id: 'persona-1', userId: 'user-42', notificationsEnabled: false });
    expect(state.lastFetchedAt).toBeNull();

    // A hydrated persona has no fetch stamp, so the next fetch goes to the server.
    servePersona();
    await state.fetchUserPersona('user-42');
    expect(asked).toEqual(['user-42']);
  });

  it('restores the re-auth flag and the cached email beside the identity', async () => {
    await setSetting('cached_user_id', 'user-1');
    await setSetting('needs_reauth', '1');
    await setSetting('cached_user_email', 'reader@example.com');
    await useUserStore.getState().hydrateFromDb();
    expect(useUserStore.getState()).toMatchObject({ needsReauth: true, userEmail: 'reader@example.com' });
  });

  it('leaves the state unchanged and does not throw when the read fails', async () => {
    await setSetting('cached_user_id', 'user-1');
    failSettingRead('cached_user_id');
    await expect(useUserStore.getState().hydrateFromDb()).resolves.toBeUndefined();
    expect(useUserStore.getState().userId).toBeNull();
  });
});
