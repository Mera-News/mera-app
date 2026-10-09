import type {
    OnboardingStage,
    ProcessingMode,
    UnblockRequest,
    UnblockRequestStatus,
    UserPersona,
} from '@/lib/generated/graphql-types';
import { FIXTURE_ACCOUNT } from '../account';

// Enums are cast, not imported: this module also runs outside Jest, where the `@/` alias
// is not resolved for runtime imports.

/** The server-side persona row: no facts live here (facts are on-device), just the
 *  account's settings. A fresh account sits at PERSONA_CHAT with notifications off. */
export function personaFor(now: number, overrides: Partial<UserPersona> = {}): UserPersona {
    const at = new Date(now).toISOString();
    return {
        __typename: 'UserPersona',
        _id: '66e2e0000000000000000002',
        userId: FIXTURE_ACCOUNT.userId,
        preferredNotificationWindow: [8, 20],
        notificationsEnabled: false,
        expoPushToken: null,
        onboardingStage: 'PERSONA_CHAT' as OnboardingStage,
        blockedByLlm: false,
        blockedByLlmReason: null,
        language_codes: ['en'],
        llmWarningCount: 0,
        processingMode: 'CLOUD' as ProcessingMode,
        lastSuccessfulCompletedAt: null,
        createdAt: at,
        updatedAt: at,
        ...overrides,
    };
}

export const persona: UserPersona = personaFor(Date.now());

export function unblockRequestFor(now: number, feedback: string): UnblockRequest {
    const at = new Date(now).toISOString();
    return {
        __typename: 'UnblockRequest',
        _id: '66e2e0000000000000000003',
        userId: FIXTURE_ACCOUNT.userId,
        feedback,
        blockedReasonSnapshot: null,
        status: 'PENDING' as UnblockRequestStatus,
        createdAt: at,
        updatedAt: at,
    };
}
