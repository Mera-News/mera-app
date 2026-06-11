// Mock apollo-client BEFORE imports — the module is side-effectful.
const mockQuery = jest.fn();
const mockMutate = jest.fn();
const mockCacheReset = jest.fn(async () => {});

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
        mutate: (...a: any[]) => mockMutate(...a),
        cache: { reset: (...a: any[]) => mockCacheReset(...a) },
    },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import AccountService from '../account-service';
import { OnboardingStage, ProcessingMode } from '../generated/graphql-types';
import logger from '@/lib/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePersona(overrides: Record<string, unknown> = {}) {
    return {
        _id: 'persona-1',
        userId: 'user-1',
        userTopics: [],
        preferredNotificationWindow: [9, 10, 11],
        notificationsEnabled: true,
        expoPushToken: 'ExponentPushToken[abc123]',
        onboardingStage: OnboardingStage.Finished,
        blockedByLlm: false,
        blockedByLlmReason: null,
        language_codes: ['en'],
        processingMode: ProcessingMode.Cloud,
        llmWarningCount: 0,
        lastSuccessfulCompletedAt: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// getUserPersona
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.getUserPersona', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the user persona on success', async () => {
        const persona = makePersona();
        mockQuery.mockResolvedValueOnce({ data: { userPersonaByUserId: persona } });

        const result = await AccountService.getUserPersona('user-1');
        expect(result).toEqual(persona);
    });

    it('returns null when userPersonaByUserId is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { userPersonaByUserId: null } });
        const result = await AccountService.getUserPersona('user-1');
        expect(result).toBeNull();
    });

    it('returns null when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await AccountService.getUserPersona('user-1');
        expect(result).toBeNull();
    });

    it('uses network-only fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { userPersonaByUserId: null } });
        await AccountService.getUserPersona('user-1');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'network-only' }),
        );
    });

    it('passes userId as variable', async () => {
        mockQuery.mockResolvedValueOnce({ data: { userPersonaByUserId: null } });
        await AccountService.getUserPersona('specific-user-id');
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ variables: { userId: 'specific-user-id' } }),
        );
    });

    it('re-throws on error and logs', async () => {
        const err = new Error('persona query failed');
        mockQuery.mockRejectedValueOnce(err);

        await expect(AccountService.getUserPersona('user-1')).rejects.toThrow('persona query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'account-service', method: 'getUserPersona' },
                extra: { userId: 'user-1' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOnboardingStage
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.getOnboardingStage', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns the onboarding stage from persona', async () => {
        mockQuery.mockResolvedValueOnce({
            data: { userPersonaByUserId: makePersona({ onboardingStage: OnboardingStage.PersonaChat }) },
        });
        const result = await AccountService.getOnboardingStage('user-1');
        expect(result).toBe(OnboardingStage.PersonaChat);
    });

    it('returns Notifications stage when persona is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: { userPersonaByUserId: null } });
        const result = await AccountService.getOnboardingStage('user-1');
        expect(result).toBe(OnboardingStage.Notifications);
    });

    it('returns Notifications stage when getUserPersona throws', async () => {
        mockQuery.mockRejectedValueOnce(new Error('network error'));
        const result = await AccountService.getOnboardingStage('user-1');
        expect(result).toBe(OnboardingStage.Notifications);
    });

    it('logs captureException when getUserPersona throws', async () => {
        const err = new Error('network error');
        mockQuery.mockRejectedValueOnce(err);
        await AccountService.getOnboardingStage('user-1');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'account-service', method: 'getOnboardingStage' },
            }),
        );
    });

    it('returns Finished when persona onboardingStage is Finished', async () => {
        mockQuery.mockResolvedValueOnce({
            data: { userPersonaByUserId: makePersona({ onboardingStage: OnboardingStage.Finished }) },
        });
        const result = await AccountService.getOnboardingStage('user-1');
        expect(result).toBe(OnboardingStage.Finished);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateNotificationPreferences (delegates to private updateNotificationWindowMutation)
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.updateNotificationPreferences', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ preferredNotificationWindow: [8, 9] });
        mockMutate.mockResolvedValueOnce({ data: { updateNotificationWindow: persona }, error: undefined });

        const result = await AccountService.updateNotificationPreferences('user-1', [8, 9]);
        expect(result).toEqual(persona);
    });

    it('passes userId and preferredNotificationWindow to mutation', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateNotificationWindow: persona }, error: undefined });

        await AccountService.updateNotificationPreferences('user-1', [7, 8, 9]);
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: {
                    input: {
                        userId: 'user-1',
                        preferredNotificationWindow: [7, 8, 9],
                    },
                },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.updateNotificationPreferences('user-1', [])).rejects.toThrow(
            'Failed to update notification window - no data returned',
        );
    });

    it('throws when error is returned', async () => {
        const graphQLError = new Error('graphql error');
        mockMutate.mockResolvedValueOnce({ data: null, error: graphQLError });
        await expect(AccountService.updateNotificationPreferences('user-1', [])).rejects.toThrow('graphql error');
    });

    it('re-throws network error and logs', async () => {
        const err = new Error('mutation failed');
        mockMutate.mockRejectedValueOnce(err);
        await expect(AccountService.updateNotificationPreferences('user-1', [])).rejects.toThrow('mutation failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateExpoPushTokenMutation
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.updateExpoPushTokenMutation', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ expoPushToken: 'ExponentPushToken[new-token]' });
        mockMutate.mockResolvedValueOnce({ data: { updateExpoPushToken: persona }, error: undefined });

        const result = await AccountService.updateExpoPushTokenMutation('user-1', 'ExponentPushToken[new-token]');
        expect(result).toEqual(persona);
    });

    it('passes token as null to clear it', async () => {
        const persona = makePersona({ expoPushToken: null });
        mockMutate.mockResolvedValueOnce({ data: { updateExpoPushToken: persona }, error: undefined });

        await AccountService.updateExpoPushTokenMutation('user-1', null);
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { input: { userId: 'user-1', expoPushToken: null } },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.updateExpoPushTokenMutation('user-1', 'token')).rejects.toThrow(
            'Failed to update expo push token - no data returned',
        );
    });

    it('throws when mutation error is present', async () => {
        const err = new Error('push token error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(AccountService.updateExpoPushTokenMutation('user-1', 'token')).rejects.toThrow('push token error');
    });

    it('re-throws network error', async () => {
        mockMutate.mockRejectedValueOnce(new Error('network'));
        await expect(AccountService.updateExpoPushTokenMutation('user-1', 'token')).rejects.toThrow('network');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: { service: 'account-service', method: 'updateExpoPushTokenMutation' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteExpoPushToken
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.deleteExpoPushToken', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ expoPushToken: null });
        mockMutate.mockResolvedValueOnce({ data: { deleteExpoPushToken: persona }, error: undefined });
        const result = await AccountService.deleteExpoPushToken('user-1');
        expect(result).toEqual(persona);
    });

    it('passes userId to mutation', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { deleteExpoPushToken: persona }, error: undefined });
        await AccountService.deleteExpoPushToken('user-1');
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { input: { userId: 'user-1' } },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.deleteExpoPushToken('user-1')).rejects.toThrow(
            'Failed to delete expo push token - no data returned',
        );
    });

    it('throws when mutation error is present', async () => {
        const err = new Error('delete error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(AccountService.deleteExpoPushToken('user-1')).rejects.toThrow('delete error');
    });

    it('re-throws network error and logs', async () => {
        mockMutate.mockRejectedValueOnce(new Error('net'));
        await expect(AccountService.deleteExpoPushToken('user-1')).rejects.toThrow('net');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: { service: 'account-service', method: 'deleteExpoPushToken' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllCountries
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.getAllCountries', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns array of country codes on success', async () => {
        mockQuery.mockResolvedValueOnce({ data: { allCountries: ['USA', 'FRA', 'DEU'] } });
        const result = await AccountService.getAllCountries();
        expect(result).toEqual(['USA', 'FRA', 'DEU']);
    });

    it('returns empty array when data is null', async () => {
        mockQuery.mockResolvedValueOnce({ data: null });
        const result = await AccountService.getAllCountries();
        expect(result).toEqual([]);
    });

    it('uses network-only fetchPolicy', async () => {
        mockQuery.mockResolvedValueOnce({ data: { allCountries: [] } });
        await AccountService.getAllCountries();
        expect(mockQuery).toHaveBeenCalledWith(
            expect.objectContaining({ fetchPolicy: 'network-only' }),
        );
    });

    it('re-throws on error', async () => {
        const err = new Error('countries query failed');
        mockQuery.mockRejectedValueOnce(err);
        await expect(AccountService.getAllCountries()).rejects.toThrow('countries query failed');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            err,
            expect.objectContaining({
                tags: { service: 'account-service', method: 'getAllCountries' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// advanceOnboardingStage
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.advanceOnboardingStage', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ onboardingStage: OnboardingStage.PersonaChat });
        mockMutate.mockResolvedValueOnce({ data: { advanceOnboardingStage: persona }, error: undefined });

        const result = await AccountService.advanceOnboardingStage('user-1', OnboardingStage.PersonaChat);
        expect(result).toEqual(persona);
    });

    it('passes userId and stage as top-level variables', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { advanceOnboardingStage: persona }, error: undefined });

        await AccountService.advanceOnboardingStage('user-1', OnboardingStage.Finished);
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { userId: 'user-1', stage: OnboardingStage.Finished },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(
            AccountService.advanceOnboardingStage('user-1', OnboardingStage.Finished),
        ).rejects.toThrow('Failed to advance onboarding stage - no data returned');
    });

    it('throws the mutation error when present', async () => {
        const err = new Error('stage error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(
            AccountService.advanceOnboardingStage('user-1', OnboardingStage.Finished),
        ).rejects.toThrow('stage error');
    });

    it('re-throws network error', async () => {
        mockMutate.mockRejectedValueOnce(new Error('net error'));
        await expect(
            AccountService.advanceOnboardingStage('user-1', OnboardingStage.Finished),
        ).rejects.toThrow('net error');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: { service: 'account-service', method: 'advanceOnboardingStage' },
            }),
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateNotificationsEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.updateNotificationsEnabled', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ notificationsEnabled: false });
        mockMutate.mockResolvedValueOnce({ data: { updateNotificationsEnabled: persona }, error: undefined });

        const result = await AccountService.updateNotificationsEnabled('user-1', false);
        expect(result).toEqual(persona);
    });

    it('passes userId and enabled flag', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateNotificationsEnabled: persona }, error: undefined });

        await AccountService.updateNotificationsEnabled('user-1', true);
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { input: { userId: 'user-1', enabled: true } },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.updateNotificationsEnabled('user-1', true)).rejects.toThrow(
            'Failed to update notifications enabled flag - no data returned',
        );
    });

    it('throws the mutation error when present', async () => {
        const err = new Error('enabled error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(AccountService.updateNotificationsEnabled('user-1', true)).rejects.toThrow('enabled error');
    });

    it('re-throws network error', async () => {
        mockMutate.mockRejectedValueOnce(new Error('net'));
        await expect(AccountService.updateNotificationsEnabled('user-1', false)).rejects.toThrow('net');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateProcessingMode
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.updateProcessingMode', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona and resets cache on success', async () => {
        const persona = makePersona({ processingMode: ProcessingMode.OnDevice });
        mockMutate.mockResolvedValueOnce({ data: { updateProcessingMode: persona }, error: undefined });
        mockCacheReset.mockResolvedValueOnce(undefined);

        const result = await AccountService.updateProcessingMode('user-1', ProcessingMode.OnDevice);
        expect(result).toEqual(persona);
        expect(mockCacheReset).toHaveBeenCalledTimes(1);
    });

    it('passes userId and mode as variables', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateProcessingMode: persona }, error: undefined });

        await AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud);
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: { input: { userId: 'user-1', mode: ProcessingMode.Cloud } },
            }),
        );
    });

    it('still returns persona even when cache.reset throws', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateProcessingMode: persona }, error: undefined });
        mockCacheReset.mockRejectedValueOnce(new Error('cache reset error'));

        const result = await AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud);
        expect(result).toEqual(persona);
        // Should log the cache reset failure
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: expect.objectContaining({ type: 'cache-reset' }),
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud)).rejects.toThrow(
            'Failed to update processing mode - no data returned',
        );
    });

    it('throws the mutation error when present', async () => {
        const err = new Error('mode error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud)).rejects.toThrow('mode error');
    });

    it('re-throws network error', async () => {
        mockMutate.mockRejectedValueOnce(new Error('net'));
        await expect(AccountService.updateProcessingMode('user-1', ProcessingMode.Cloud)).rejects.toThrow('net');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateUserConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('AccountService.updateUserConfig', () => {
    beforeEach(() => jest.clearAllMocks());

    it('returns updated persona on success', async () => {
        const persona = makePersona({ language_codes: ['fr', 'en'] });
        mockMutate.mockResolvedValueOnce({ data: { updateUserConfig: persona }, error: undefined });

        const result = await AccountService.updateUserConfig('user-1', { language_codes: ['fr', 'en'] });
        expect(result).toEqual(persona);
    });

    it('passes userId and language_codes as variables', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateUserConfig: persona }, error: undefined });

        await AccountService.updateUserConfig('user-1', { language_codes: ['de'] });
        expect(mockMutate).toHaveBeenCalledWith(
            expect.objectContaining({
                variables: {
                    input: {
                        userId: 'user-1',
                        language_codes: ['de'],
                    },
                },
            }),
        );
    });

    it('throws when data is null', async () => {
        mockMutate.mockResolvedValueOnce({ data: null, error: undefined });
        await expect(AccountService.updateUserConfig('user-1', {})).rejects.toThrow(
            'Failed to update user config - no data returned',
        );
    });

    it('throws the mutation error when present', async () => {
        const err = new Error('config error');
        mockMutate.mockResolvedValueOnce({ data: null, error: err });
        await expect(AccountService.updateUserConfig('user-1', {})).rejects.toThrow('config error');
    });

    it('re-throws network error and logs', async () => {
        mockMutate.mockRejectedValueOnce(new Error('net'));
        await expect(AccountService.updateUserConfig('user-1', {})).rejects.toThrow('net');
        expect((logger.captureException as jest.Mock)).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({
                tags: { service: 'account-service', method: 'updateUserConfig' },
                extra: { userId: 'user-1' },
            }),
        );
    });

    it('spreads arbitrary config fields into the input', async () => {
        const persona = makePersona();
        mockMutate.mockResolvedValueOnce({ data: { updateUserConfig: persona }, error: undefined });

        await AccountService.updateUserConfig('user-1', { language_codes: ['ja', 'ko'] });
        const call = (mockMutate as jest.Mock).mock.calls[0][0];
        expect(call.variables.input).toMatchObject({ userId: 'user-1', language_codes: ['ja', 'ko'] });
    });
});
