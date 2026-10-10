// language-sync at its seam: the real user store and app-language store, the real AccountService
// and Apollo client, MSW, and the in-memory DB. Asserts the UpdateUserConfig variables that
// cross the wire and the store / DB state afterwards. Replaces lib/__tests__/language-sync.test.ts.
import {
  mergePrimaryLanguage,
  reconcileAppLanguageWithPersona,
  syncAppLanguageToPersona,
} from '@/lib/language-sync';
import database from '@/lib/database';
import { loadUserPersona } from '@/lib/database/services/user-persona-service';
import type { UserPersona } from '@/lib/account-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useUserStore } from '@/lib/stores/user-store';
import { mockGqlError, server } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { resetNetworkMemory, serve, spyLogger, type Vars } from './kit';

let log: ReturnType<typeof spyLogger>;
let updates: Vars[];
let fetched: Vars[];

/** The persona the server holds; GetUserPersona answers with it, UpdateUserConfig echoes the codes sent. */
function serveServer(serverPersona: UserPersona | null = null) {
  fetched = serve('GetUserPersona', () => ({ userPersonaByUserId: serverPersona }));
  updates = serve('UpdateUserConfig', (v) => ({
    updateUserConfig: personaFor(Date.now(), {
      userId: String((v.input as Vars).userId),
      language_codes: (v.input as Vars).language_codes as string[],
    }),
  }));
}

const persona = (userId: string, language_codes: string[] | null | undefined) =>
  personaFor(Date.now(), { userId, language_codes: language_codes as string[] });

const signedInAs = (userId: string, language_codes: string[] | null | undefined) =>
  useUserStore.setState({ userId, userPersona: persona(userId, language_codes) });

/** The persona row persists fire-and-forget; an empty write queues behind it, then the row is read once. */
async function storedCodes(userId: string) {
  await database.write(async () => undefined);
  return (await loadUserPersona(userId))?.language_codes;
}

beforeEach(() => {
  resetNetworkMemory();
  log = spyLogger();
  useUserStore.setState(useUserStore.getInitialState(), true);
  useAppLanguageStore.setState({ appLanguage: 'en' });
  serveServer();
});
afterEach(async () => {
  log.restore();
  // setUserPersona and fetchUserPersona persist without being awaited; let that land before the next test's DB reset.
  await database.write(async () => undefined);
});

describe('mergePrimaryLanguage', () => {
  it('prepends the language as primary, preserving the rest', () => {
    expect(mergePrimaryLanguage('fr', ['en', 'de'])).toEqual(['fr', 'en', 'de']);
  });

  it('is a no-op ordering when already primary', () => {
    expect(mergePrimaryLanguage('en', ['en', 'de'])).toEqual(['en', 'de']);
  });

  it('moves an existing non-primary code to the front without duplicating', () => {
    expect(mergePrimaryLanguage('de', ['en', 'de'])).toEqual(['de', 'en']);
  });

  it('handles an empty existing array', () => {
    expect(mergePrimaryLanguage('fr', [])).toEqual(['fr']);
  });
});

describe('syncAppLanguageToPersona', () => {
  it('sets the picked language as primary, preserves the other codes and reflects it locally', async () => {
    const seeded = persona('u1', ['en', 'de']);
    useUserStore.setState({ userId: 'u1', userPersona: seeded });

    await syncAppLanguageToPersona('fr');

    expect(updates).toEqual([{ input: { userId: 'u1', language_codes: ['fr', 'en', 'de'] } }]);
    // The local persona keeps its other fields and carries the merge.
    expect(useUserStore.getState().userPersona).toEqual({ ...seeded, language_codes: ['fr', 'en', 'de'] });
    // ...and so does the cached row the boot-reconciliation guard reads.
    expect(await storedCodes('u1')).toEqual(['fr', 'en', 'de']);
  });

  it('does nothing when the language is already primary', async () => {
    signedInAs('u1', ['fr', 'en']);

    await syncAppLanguageToPersona('fr');

    expect(updates).toEqual([]);
    expect(fetched).toEqual([]);
    expect(useUserStore.getState().userPersona?.language_codes).toEqual(['fr', 'en']);
  });

  it('skips entirely when there is no logged-in user', async () => {
    await syncAppLanguageToPersona('fr');

    expect(updates).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('uses an explicit user id and fetches the persona when none is cached', async () => {
    serveServer(persona('u9', ['en']));

    await syncAppLanguageToPersona('de', { userId: 'u9' });

    expect(fetched).toEqual([{ userId: 'u9' }]);
    expect(updates).toEqual([{ input: { userId: 'u9', language_codes: ['de', 'en'] } }]);
    expect(useUserStore.getState().userPersona?.language_codes).toEqual(['de', 'en']);
  });

  it('fetches when the cached persona belongs to a different user', async () => {
    signedInAs('someone-else', ['en']);
    serveServer(persona('u2', ['en', 'it']));

    await syncAppLanguageToPersona('de', { userId: 'u2' });

    expect(fetched).toEqual([{ userId: 'u2' }]);
    expect(updates).toEqual([{ input: { userId: 'u2', language_codes: ['de', 'en', 'it'] } }]);
  });

  it.each([[undefined], [null]])('treats a persona with language_codes %s as an empty array', async (codes) => {
    signedInAs('u1', codes);

    await syncAppLanguageToPersona('es');

    expect(updates).toEqual([{ input: { userId: 'u1', language_codes: ['es'] } }]);
  });

  it('sends the code for a user whose persona the server does not have', async () => {
    serveServer(null);

    await syncAppLanguageToPersona('es', { userId: 'u3' });

    expect(updates).toEqual([{ input: { userId: 'u3', language_codes: ['es'] } }]);
  });

  it('never throws and logs when the server update fails, leaving the local persona alone', async () => {
    signedInAs('u1', ['en']);
    server.use(mockGqlError('UpdateUserConfig', 'INTERNAL_SERVER_ERROR', { message: 'network' }));

    await expect(syncAppLanguageToPersona('fr')).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      '[language-sync] failed to sync app language to persona',
      expect.objectContaining({ error: expect.stringContaining('network') }),
    );
    expect(useUserStore.getState().userPersona?.language_codes).toEqual(['en']);
  });

  // CO6: the merge runs against the freshest server persona so it never clobbers codes the
  // on-device LLM added server-side. When that persona cannot be fetched, nothing is written.
  describe('when the persona fetch fails', () => {
    beforeEach(() => {
      server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR', { message: 'fetch down' }));
      updates = serve('UpdateUserConfig', (v) => ({
        updateUserConfig: personaFor(Date.now(), {
          userId: 'u4',
          language_codes: (v.input as Vars).language_codes as string[],
        }),
      }));
    });

    test('CO6: leaves the server language_codes alone when the persona could not be fetched', async () => {
      await syncAppLanguageToPersona('fr', { userId: 'u4' });
      expect(updates).toEqual([]);
    });
  });
});

describe('reconcileAppLanguageWithPersona', () => {
  it('syncs when the persona primary differs from the app language', async () => {
    useAppLanguageStore.setState({ appLanguage: 'fr' });
    signedInAs('u1', ['en']);

    await reconcileAppLanguageWithPersona();

    expect(updates).toEqual([{ input: { userId: 'u1', language_codes: ['fr', 'en'] } }]);
  });

  it('does nothing when the persona primary already matches', async () => {
    useAppLanguageStore.setState({ appLanguage: 'en' });
    signedInAs('u1', ['en', 'de']);

    await reconcileAppLanguageWithPersona();

    expect(updates).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('skips when there is no logged-in user', async () => {
    useAppLanguageStore.setState({ appLanguage: 'fr' });

    await reconcileAppLanguageWithPersona();

    expect(updates).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('accepts an explicit user id (onboarding) and syncs on mismatch', async () => {
    useAppLanguageStore.setState({ appLanguage: 'de' });
    serveServer(persona('u2', ['en']));

    await reconcileAppLanguageWithPersona({ userId: 'u2' });

    expect(fetched).toEqual([{ userId: 'u2' }]);
    expect(updates).toEqual([{ input: { userId: 'u2', language_codes: ['de', 'en'] } }]);
  });

  it('treats another user\'s cached persona as no primary and syncs', async () => {
    useAppLanguageStore.setState({ appLanguage: 'en' });
    signedInAs('someone-else', ['en']);
    serveServer(persona('u2', ['fr']));

    await reconcileAppLanguageWithPersona({ userId: 'u2' });

    expect(updates).toEqual([{ input: { userId: 'u2', language_codes: ['en', 'fr'] } }]);
  });
});
