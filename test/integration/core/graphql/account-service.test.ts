// AccountService at its seam: the real Apollo client (real link chain) talks to MSW. Asserts the
// variables each operation sends, the persona it hands back, the error path (a GraphQL error and
// a transport failure) and the one side effect it has (the cache reset after a mode switch).
// Replaces lib/__tests__/account-service.test.ts.
import { gql } from '@apollo/client';
import { AccountService } from '@/lib/account-service';
import client from '@/lib/apollo-client';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';
import { mockGqlError, server } from '@/test/helpers';
import { personaFor, unblockRequestFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { failTransport, rejectionOf, resetNetworkMemory, underClock, serve, spyLogger, type Vars } from './kit';

const ALL_COUNTRIES_DOC = gql`
  query CacheProbeCountries {
    allCountries
  }
`;

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  log = spyLogger();
});
afterEach(() => log.restore());

const persona = (overrides: Parameters<typeof personaFor>[1] = {}) =>
  personaFor(Date.now(), { userId: 'user-1', ...overrides });

/** The logger call the service makes for a failure, ignoring the error link's own capture. */
const expectServiceCapture = (method: string, extra?: Vars) =>
  expect(log.captureException).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      tags: { service: 'account-service', method },
      ...(extra ? { extra } : {}),
    }),
  );

// ---------------------------------------------------------------------------------------------
// getUserPersona / getOnboardingStage
// ---------------------------------------------------------------------------------------------

describe('AccountService.getUserPersona', () => {
  it('returns the persona and sends the user id as the only variable', async () => {
    const reply = persona({ language_codes: ['en', 'de'] });
    const seen = serve('GetUserPersona', () => ({ userPersonaByUserId: reply }));

    await expect(AccountService.getUserPersona('specific-user-id')).resolves.toEqual(reply);
    expect(seen).toEqual([{ userId: 'specific-user-id' }]);
  });

  it('returns null when the server has no persona', async () => {
    serve('GetUserPersona', () => ({ userPersonaByUserId: null }));
    await expect(AccountService.getUserPersona('user-1')).resolves.toBeNull();
  });

  it('uses network-only: the same user is asked twice, never answered from the cache', async () => {
    const seen = serve('GetUserPersona', () => ({ userPersonaByUserId: persona() }));
    await AccountService.getUserPersona('user-1');
    await AccountService.getUserPersona('user-1');
    expect(seen).toHaveLength(2);
  });

  it('re-throws a GraphQL error and logs it with the user id', async () => {
    server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR', { message: 'persona query failed' }));
    await expect(AccountService.getUserPersona('user-1')).rejects.toThrow('persona query failed');
    expectServiceCapture('getUserPersona', { userId: 'user-1' });
  });

  it('re-throws a transport failure and logs it', async () => {
    server.use(failTransport('GetUserPersona'));
    expect(await rejectionOf(() => AccountService.getUserPersona('user-1'))).toBeInstanceOf(Error);
    expectServiceCapture('getUserPersona', { userId: 'user-1' });
  });
});

describe('AccountService.getOnboardingStage', () => {
  it.each([OnboardingStage.PersonaChat, OnboardingStage.Finished])('returns the persona stage %s', async (stage) => {
    serve('GetUserPersona', () => ({ userPersonaByUserId: persona({ onboardingStage: stage }) }));
    await expect(AccountService.getOnboardingStage('user-1')).resolves.toBe(stage);
  });

  it('returns Notifications (start from the beginning) when there is no persona', async () => {
    serve('GetUserPersona', () => ({ userPersonaByUserId: null }));
    await expect(AccountService.getOnboardingStage('user-1')).resolves.toBe(OnboardingStage.Notifications);
  });

  it('returns Notifications and logs when the persona query fails', async () => {
    server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR', { message: 'network error' }));
    await expect(AccountService.getOnboardingStage('user-1')).resolves.toBe(OnboardingStage.Notifications);
    expectServiceCapture('getOnboardingStage');
  });

  it('returns Notifications when the transport fails', async () => {
    server.use(failTransport('GetUserPersona'));
    expect(await underClock(() => AccountService.getOnboardingStage('user-1'))).toBe(OnboardingStage.Notifications);
  });
});

// ---------------------------------------------------------------------------------------------
// The persona mutations share one shape: variables out, persona back, "no data" and failure paths.
// ---------------------------------------------------------------------------------------------

interface MutationCase {
  name: string;
  op: string;
  key: string;
  call: () => Promise<unknown>;
  variables: Vars;
  reply: Parameters<typeof personaFor>[1];
  noData: string;
  method: string;
  extra: Vars;
}

const cases: MutationCase[] = [
  {
    name: 'updateNotificationPreferences',
    op: 'UpdateNotificationWindow',
    key: 'updateNotificationWindow',
    call: () => AccountService.updateNotificationPreferences('user-1', [7, 8, 9]),
    variables: { input: { userId: 'user-1', preferredNotificationWindow: [7, 8, 9] } },
    reply: { preferredNotificationWindow: [7, 8, 9] },
    noData: 'Failed to update notification window - no data returned',
    method: 'updateNotificationWindowMutation',
    extra: { userId: 'user-1', preferredNotificationWindow: [7, 8, 9] },
  },
  {
    name: 'updateExpoPushTokenMutation',
    op: 'UpdateExpoPushToken',
    key: 'updateExpoPushToken',
    call: () => AccountService.updateExpoPushTokenMutation('user-1', 'ExponentPushToken[new-token]'),
    variables: { input: { userId: 'user-1', expoPushToken: 'ExponentPushToken[new-token]' } },
    reply: { expoPushToken: 'ExponentPushToken[new-token]' },
    noData: 'Failed to update expo push token - no data returned',
    method: 'updateExpoPushTokenMutation',
    extra: { userId: 'user-1' },
  },
  {
    name: 'deleteExpoPushToken',
    op: 'DeleteExpoPushToken',
    key: 'deleteExpoPushToken',
    call: () => AccountService.deleteExpoPushToken('user-1'),
    variables: { input: { userId: 'user-1' } },
    reply: { expoPushToken: null },
    noData: 'Failed to delete expo push token - no data returned',
    method: 'deleteExpoPushToken',
    extra: { userId: 'user-1' },
  },
  {
    name: 'advanceOnboardingStage',
    op: 'AdvanceOnboardingStage',
    key: 'advanceOnboardingStage',
    call: () => AccountService.advanceOnboardingStage('user-1', OnboardingStage.Finished),
    variables: { userId: 'user-1', stage: OnboardingStage.Finished },
    reply: { onboardingStage: OnboardingStage.Finished },
    noData: 'Failed to advance onboarding stage - no data returned',
    method: 'advanceOnboardingStage',
    extra: { userId: 'user-1', stage: OnboardingStage.Finished },
  },
  {
    name: 'updateNotificationsEnabled',
    op: 'UpdateNotificationsEnabled',
    key: 'updateNotificationsEnabled',
    call: () => AccountService.updateNotificationsEnabled('user-1', false),
    variables: { input: { userId: 'user-1', enabled: false } },
    reply: { notificationsEnabled: false },
    noData: 'Failed to update notifications enabled flag - no data returned',
    method: 'updateNotificationsEnabled',
    extra: { userId: 'user-1', enabled: false },
  },
  {
    name: 'updateProcessingMode',
    op: 'UpdateProcessingMode',
    key: 'updateProcessingMode',
    call: () => AccountService.updateProcessingMode('user-1', ProcessingMode.OnDevice),
    variables: { input: { userId: 'user-1', mode: ProcessingMode.OnDevice } },
    reply: { processingMode: ProcessingMode.OnDevice },
    noData: 'Failed to update processing mode - no data returned',
    method: 'updateProcessingMode',
    extra: { userId: 'user-1', mode: ProcessingMode.OnDevice },
  },
  {
    name: 'updateUserConfig',
    op: 'UpdateUserConfig',
    key: 'updateUserConfig',
    call: () => AccountService.updateUserConfig('user-1', { language_codes: ['fr', 'en'] }),
    variables: { input: { userId: 'user-1', language_codes: ['fr', 'en'] } },
    reply: { language_codes: ['fr', 'en'] },
    noData: 'Failed to update user config - no data returned',
    method: 'updateUserConfig',
    extra: { userId: 'user-1' },
  },
  {
    name: 'issueLlmWarning',
    op: 'IssueLlmWarning',
    key: 'issueLlmWarning',
    call: () => AccountService.issueLlmWarning('user-1', 'prompt injection'),
    variables: { input: { userId: 'user-1', reason: 'prompt injection' } },
    reply: { llmWarningCount: 3, blockedByLlm: true, blockedByLlmReason: 'prompt injection' },
    noData: 'Failed to issue LLM warning - no data returned',
    method: 'issueLlmWarning',
    extra: { userId: 'user-1' },
  },
];

describe.each(cases)('AccountService.$name', (c) => {
  it('sends the variables and returns the persona the server answered', async () => {
    const reply = persona(c.reply);
    const seen = serve(c.op, () => ({ [c.key]: reply }));

    const result = await c.call();

    expect(seen).toEqual([c.variables]);
    expect(result).toMatchObject({ _id: reply._id, ...c.reply });
  });

  it('throws when the server returns no persona', async () => {
    serve(c.op, () => ({ [c.key]: null }));
    await expect(c.call()).rejects.toThrow(c.noData);
    expectServiceCapture(c.method, c.extra);
  });

  it('re-throws a GraphQL error and logs it', async () => {
    server.use(mockGqlError(c.op, 'INTERNAL_SERVER_ERROR', { message: `${c.name} error` }));
    await expect(c.call()).rejects.toThrow(`${c.name} error`);
    expectServiceCapture(c.method, c.extra);
  });

  it('re-throws a transport failure and logs it', async () => {
    server.use(failTransport(c.op));
    expect(await rejectionOf(c.call)).toBeInstanceOf(Error);
    expectServiceCapture(c.method, c.extra);
  });
});

describe('AccountService.updateExpoPushTokenMutation with a null token', () => {
  it('sends null to clear the token', async () => {
    const seen = serve('UpdateExpoPushToken', () => ({ updateExpoPushToken: persona({ expoPushToken: null }) }));
    await AccountService.updateExpoPushTokenMutation('user-1', null);
    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: null } }]);
  });
});

describe('AccountService.updateUserConfig input', () => {
  it('spreads the config fields into the input next to the user id', async () => {
    const seen = serve('UpdateUserConfig', () => ({ updateUserConfig: persona({ language_codes: ['ja', 'ko'] }) }));
    await AccountService.updateUserConfig('user-1', { language_codes: ['ja', 'ko'] });
    expect((seen[0].input as Vars)).toMatchObject({ userId: 'user-1', language_codes: ['ja', 'ko'] });
  });

  it('sends only the user id for an empty config', async () => {
    const seen = serve('UpdateUserConfig', () => ({ updateUserConfig: persona() }));
    await AccountService.updateUserConfig('user-1', {});
    expect(seen).toEqual([{ input: { userId: 'user-1' } }]);
  });
});

// ---------------------------------------------------------------------------------------------
// updateProcessingMode: the Apollo cache is reset after a successful switch.
// ---------------------------------------------------------------------------------------------

describe('AccountService.updateProcessingMode cache reset', () => {
  it('empties the Apollo cache after the switch (the mutation result alone would leave entries)', async () => {
    serve('UpdateProcessingMode', () => ({ updateProcessingMode: persona({ processingMode: ProcessingMode.Cloud }) }));
    await client.cache.reset();
    // A write that lands before the reset: the mutation result itself normalises into the cache.
    client.cache.writeQuery({ query: ALL_COUNTRIES_DOC, data: { allCountries: ['USA'] } });
    expect(Object.keys(client.cache.extract() as Record<string, unknown>).length).toBeGreaterThan(0);

    await AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud);

    expect(client.cache.extract()).toEqual({});
  });

  it('still returns the persona and logs the failure when the cache reset throws', async () => {
    const reply = persona({ processingMode: ProcessingMode.Cloud });
    serve('UpdateProcessingMode', () => ({ updateProcessingMode: reply }));
    const reset = jest.spyOn(client.cache, 'reset').mockRejectedValueOnce(new Error('cache reset error'));

    const result = await AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud);

    expect(result).toMatchObject({ _id: reply._id, processingMode: ProcessingMode.Cloud });
    expect(log.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'cache reset error' }),
      expect.objectContaining({ tags: expect.objectContaining({ type: 'cache-reset' }) }),
    );
    reset.mockRestore();
  });

  it('leaves the cache alone when the mutation fails', async () => {
    server.use(mockGqlError('UpdateProcessingMode', 'INTERNAL_SERVER_ERROR', { message: 'mode error' }));
    const reset = jest.spyOn(client.cache, 'reset');
    await expect(AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud)).rejects.toThrow('mode error');
    expect(reset).not.toHaveBeenCalled();
    reset.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// getAllCountries
// ---------------------------------------------------------------------------------------------

describe('AccountService.getAllCountries', () => {
  it('returns the country codes', async () => {
    serve('AllCountries', () => ({ allCountries: ['USA', 'FRA', 'DEU'] }));
    await expect(AccountService.getAllCountries()).resolves.toEqual(['USA', 'FRA', 'DEU']);
  });

  it('returns an empty list when the server answers null', async () => {
    serve('AllCountries', () => ({ allCountries: null }));
    await expect(AccountService.getAllCountries()).resolves.toEqual([]);
  });

  it('uses network-only: asked on every call', async () => {
    const seen = serve('AllCountries', () => ({ allCountries: [] }));
    await AccountService.getAllCountries();
    await AccountService.getAllCountries();
    expect(seen).toHaveLength(2);
  });

  it('re-throws a GraphQL error and logs it', async () => {
    server.use(mockGqlError('AllCountries', 'INTERNAL_SERVER_ERROR', { message: 'countries query failed' }));
    await expect(AccountService.getAllCountries()).rejects.toThrow('countries query failed');
    expectServiceCapture('getAllCountries');
  });

  it('re-throws a transport failure', async () => {
    server.use(failTransport('AllCountries'));
    expect(await rejectionOf(() => AccountService.getAllCountries())).toBeInstanceOf(Error);
    expectServiceCapture('getAllCountries');
  });
});

// ---------------------------------------------------------------------------------------------
// requestUnblock / getPendingUnblockRequest
// ---------------------------------------------------------------------------------------------

describe('AccountService.requestUnblock', () => {
  const chatHistory = [{ role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' }];

  it('sends the user id, feedback and chat transcript and returns the request', async () => {
    const seen = serve('RequestUnblock', (v) => ({
      requestUnblock: unblockRequestFor(Date.now(), String((v.input as Vars).feedback)),
    }));

    const result = await AccountService.requestUnblock({ userId: 'user-1', feedback: 'please', chatHistory });

    expect(seen).toEqual([{ input: { userId: 'user-1', feedback: 'please', chatHistory } }]);
    expect(result).toMatchObject({ feedback: 'please', status: 'PENDING' });
  });

  it('throws when the server returns no request', async () => {
    serve('RequestUnblock', () => ({ requestUnblock: null }));
    await expect(AccountService.requestUnblock({ userId: 'user-1', feedback: 'x', chatHistory })).rejects.toThrow(
      'Failed to request unblock - no data returned',
    );
    expectServiceCapture('requestUnblock', { userId: 'user-1' });
  });

  it('re-throws the server rejection (not blocked / already pending) and logs it', async () => {
    server.use(mockGqlError('RequestUnblock', 'BAD_USER_INPUT', { message: 'already pending' }));
    await expect(AccountService.requestUnblock({ userId: 'user-1', feedback: 'x', chatHistory })).rejects.toThrow(
      'already pending',
    );
    expectServiceCapture('requestUnblock', { userId: 'user-1' });
  });

  it('re-throws a transport failure', async () => {
    server.use(failTransport('RequestUnblock'));
    expect(
      await rejectionOf(() => AccountService.requestUnblock({ userId: 'user-1', feedback: 'x', chatHistory })),
    ).toBeInstanceOf(Error);
  });
});

describe('AccountService.getPendingUnblockRequest', () => {
  it('returns the pending request for the user', async () => {
    const seen = serve('UnblockRequestStatus', () => ({ unblockRequestStatus: unblockRequestFor(Date.now(), 'why') }));
    await expect(AccountService.getPendingUnblockRequest('user-1')).resolves.toMatchObject({
      feedback: 'why',
      status: 'PENDING',
    });
    expect(seen).toEqual([{ userId: 'user-1' }]);
  });

  it('returns null when there is none', async () => {
    serve('UnblockRequestStatus', () => ({ unblockRequestStatus: null }));
    await expect(AccountService.getPendingUnblockRequest('user-1')).resolves.toBeNull();
  });

  it('re-throws a GraphQL error and logs it', async () => {
    server.use(mockGqlError('UnblockRequestStatus', 'INTERNAL_SERVER_ERROR', { message: 'status failed' }));
    await expect(AccountService.getPendingUnblockRequest('user-1')).rejects.toThrow('status failed');
    expectServiceCapture('getPendingUnblockRequest', { userId: 'user-1' });
  });
});
