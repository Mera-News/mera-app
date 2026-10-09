// user-persona-service at its seam: the one persona row a device holds, over the in-memory DB.
// Replaces lib/database/services/__tests__/user-persona-service.test.ts, whose database mock
// ignored the user_id predicate (so "loadUserPersona(user-1)" returned whatever rows it was handed
// and "the first row when several match" was a test of the mock) and pinned assertPersonaOwner by
// its query arguments. Here the predicate is a real predicate.
//
// Not carried over: "uses the first row when multiple records match". persistUserPersona wipes
// every row inside the write that creates the new one, and database.write is serialized, so a
// second row for the same user cannot be produced through any service.
//
// Observation, not a bug: a null language_codes is stored as JSON null and the model's sanitizer
// reads it back as [] (consumers all use `?? []`).
import { authClient } from '@/lib/auth-client';
import {
  assertPersonaOwner,
  clearUserPersona,
  loadUserPersona,
  persistUserPersona,
} from '@/lib/database/services/user-persona-service';
import { OnboardingStage, ProcessingMode, type UserPersona } from '@/lib/generated/graphql-types';
import { FIXTURE_ACCOUNT, signInFixtureAccount } from '@/test/helpers';
import { countRows, failNextQuery, freezeClock, quietLogger, restoreFaults, T0 } from './support';

beforeEach(() => freezeClock());
afterEach(restoreFaults);

const CREATED = '2024-01-01T00:00:00.000Z';
const UPDATED = '2024-06-01T00:00:00.000Z';

const persona = (over: Record<string, unknown> = {}): UserPersona =>
  ({
    _id: 'server-persona-1',
    userId: 'ignored-the-argument-wins',
    processingMode: ProcessingMode.Cloud,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    llmWarningCount: 0,
    notificationsEnabled: true,
    preferredNotificationWindow: [9, 10],
    language_codes: ['en'],
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...over,
  }) as UserPersona;

describe('persistUserPersona and loadUserPersona', () => {
  it('round-trips every field, keyed by the user id string', async () => {
    await persistUserPersona('user-1', persona({
      _id: 'srv-123',
      processingMode: ProcessingMode.OnDevice,
      onboardingStage: OnboardingStage.PersonaChat,
      blockedByLlm: true,
      blockedByLlmReason: 'test reason',
      llmWarningCount: 2,
      notificationsEnabled: false,
      preferredNotificationWindow: [7, 8, 9],
      language_codes: ['en', 'de'],
    }));

    expect(await loadUserPersona('user-1')).toEqual({
      _id: 'srv-123',
      userId: 'user-1',
      processingMode: ProcessingMode.OnDevice,
      onboardingStage: OnboardingStage.PersonaChat,
      blockedByLlm: true,
      blockedByLlmReason: 'test reason',
      llmWarningCount: 2,
      notificationsEnabled: false,
      preferredNotificationWindow: [7, 8, 9],
      language_codes: ['en', 'de'],
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
  });

  it('is null for a user with no row, and finds a 24-hex id only as that exact string', async () => {
    expect(await loadUserPersona('user-1')).toBeNull();

    await persistUserPersona(FIXTURE_ACCOUNT.userId, persona());
    expect((await loadUserPersona(FIXTURE_ACCOUNT.userId))?.userId).toBe(FIXTURE_ACCOUNT.userId);
    expect(await loadUserPersona(FIXTURE_ACCOUNT.userId.toUpperCase())).toBeNull();
    expect(await loadUserPersona('user-1')).toBeNull();
  });

  it('keeps only one user on the device: persisting another wipes the first', async () => {
    await persistUserPersona('user-1', persona({ _id: 'p1' }));
    await persistUserPersona('user-2', persona({ _id: 'p2' }));

    expect(await countRows('user_personas')).toBe(1);
    expect(await loadUserPersona('user-1')).toBeNull();
    expect((await loadUserPersona('user-2'))?._id).toBe('p2');
  });

  it('replaces the same user\'s row rather than adding a second', async () => {
    await persistUserPersona('user-1', persona({ llmWarningCount: 1 }));
    await persistUserPersona('user-1', persona({ llmWarningCount: 5 }));

    expect(await countRows('user_personas')).toBe(1);
    expect((await loadUserPersona('user-1'))?.llmWarningCount).toBe(5);
  });

  it('stores a missing blocked reason as null and a missing notificationsEnabled as false', async () => {
    await persistUserPersona('user-1', persona({ blockedByLlmReason: undefined, notificationsEnabled: undefined }));

    expect(await loadUserPersona('user-1')).toMatchObject({ blockedByLlmReason: null, notificationsEnabled: false });
  });

  it('reads a missing language_codes back as an empty list', async () => {
    await persistUserPersona('user-1', persona({ language_codes: undefined }));
    expect((await loadUserPersona('user-1'))?.language_codes).toEqual([]);
  });

  describe('timestamps', () => {
    const times = async (over: Record<string, unknown>) => {
      await persistUserPersona('user-1', persona(over));
      const loaded = (await loadUserPersona('user-1'))!;
      return [loaded.createdAt, loaded.updatedAt];
    };

    it('accepts epoch milliseconds and Date objects', async () => {
      expect(await times({ createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000 })).toEqual([
        new Date(1_700_000_000_000).toISOString(),
        new Date(1_700_000_001_000).toISOString(),
      ]);
      const d = new Date('2023-05-10T12:00:00Z');
      expect(await times({ createdAt: d, updatedAt: d })).toEqual([d.toISOString(), d.toISOString()]);
    });

    it('falls back to now for an unparseable string, null and a non-time value', async () => {
      const now = new Date(T0).toISOString();
      expect(await times({ createdAt: 'not-a-date', updatedAt: 'also-bad' })).toEqual([now, now]);
      expect(await times({ createdAt: null, updatedAt: null })).toEqual([now, now]);
      expect(await times({ createdAt: { not: 'a date' }, updatedAt: undefined })).toEqual([now, now]);
    });
  });

  describe('enum columns', () => {
    it('reads ON_DEVICE and CLOUD, and anything else as CLOUD', async () => {
      const mode = async (value: string) => {
        await persistUserPersona('user-1', persona({ processingMode: value }));
        return (await loadUserPersona('user-1'))!.processingMode;
      };
      expect(await mode(ProcessingMode.OnDevice)).toBe(ProcessingMode.OnDevice);
      expect(await mode(ProcessingMode.Cloud)).toBe(ProcessingMode.Cloud);
      expect(await mode('unknown_mode')).toBe(ProcessingMode.Cloud);
    });

    it('reads every onboarding stage, and anything else as the first one (NOTIFICATIONS)', async () => {
      const stage = async (value: string) => {
        await persistUserPersona('user-1', persona({ onboardingStage: value }));
        return (await loadUserPersona('user-1'))!.onboardingStage;
      };
      for (const s of [OnboardingStage.Finished, OnboardingStage.ProcessingMode, OnboardingStage.PersonaChat, OnboardingStage.Notifications]) {
        expect(await stage(s)).toBe(s);
      }
      expect(await stage('UNKNOWN_STAGE')).toBe(OnboardingStage.Notifications);
    });
  });
});

describe('clearUserPersona', () => {
  it('removes the row', async () => {
    await persistUserPersona('user-1', persona());
    await clearUserPersona();

    expect(await countRows('user_personas')).toBe(0);
    expect(await loadUserPersona('user-1')).toBeNull();
  });

  it('is a no-op on an empty table', async () => {
    await expect(clearUserPersona()).resolves.toBeUndefined();
    expect(await countRows('user_personas')).toBe(0);
  });
});

// A destructive trigger. user_personas is the only user-data table with a user_id column, so a
// foreign row is independent evidence of contamination even when cached_user_id was lost. It can
// only CONFIRM, never clear: a clean device may hold zero rows.
describe('assertPersonaOwner', () => {
  // The fixture account signs in through MSW, which needs real macrotask turns.
  beforeEach(() => jest.useRealTimers());

  async function signedInId(): Promise<string> {
    await signInFixtureAccount();
    const { data } = await authClient.getSession();
    return data!.user.id;
  }

  it('is false for the signed-in fixture account\'s own persona', async () => {
    const logs = quietLogger();
    const me = await signedInId();
    expect(me).toBe(FIXTURE_ACCOUNT.userId);
    await persistUserPersona(me, persona());

    await expect(assertPersonaOwner(me)).resolves.toBe(false);
    expect(logs.captureMessage).not.toHaveBeenCalled();
  });

  it('is true, and reported once with the count, when the persona on the device is another account\'s', async () => {
    const logs = quietLogger();
    const me = await signedInId();
    await persistUserPersona('66e2e0000000000000000002', persona()); // a foreign id seeded locally (T-account2)

    await expect(assertPersonaOwner(me)).resolves.toBe(true);

    expect(logs.captureMessage).toHaveBeenCalledTimes(1);
    expect(logs.captureMessage).toHaveBeenCalledWith(
      'Persona rows on this device belong to a different user',
      expect.objectContaining({ level: 'error', extra: { foreignRowCount: 1 } }),
    );
  });

  it('is false on a clean device, which proves nothing (it can only confirm)', async () => {
    const logs = quietLogger();
    await expect(assertPersonaOwner(FIXTURE_ACCOUNT.userId)).resolves.toBe(false);
    expect(logs.captureMessage).not.toHaveBeenCalled();
  });

  it('is false, without reading, for an empty owner id', async () => {
    const logs = quietLogger();
    await persistUserPersona('somebody-else', persona());

    await expect(assertPersonaOwner('')).resolves.toBe(false);
    expect(logs.captureMessage).not.toHaveBeenCalled();
  });

  it('is false rather than throwing when the read fails', async () => {
    const logs = quietLogger();
    await persistUserPersona('somebody-else', persona());
    failNextQuery('user_personas');

    await expect(assertPersonaOwner('user-1')).resolves.toBe(false);
    expect(logs.captureMessage).not.toHaveBeenCalled();
  });
});
