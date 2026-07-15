import { gql } from '@apollo/client';
import client from './apollo-client';
import { OnboardingStage, ProcessingMode } from './generated/graphql-types';
import logger from './logger';

const GET_USER_PERSONA = gql`
  query GetUserPersona($userId: ID!) {
    userPersonaByUserId(userId: $userId) {
      _id
      userId
      userTopics {
        _id
        news_topic_text
        cluster_count
        article_count
        is_canonical
        createdAt
        updatedAt
      }
      preferredNotificationWindow
      notificationsEnabled
      expoPushToken
      onboardingStage
      blockedByLlm
      blockedByLlmReason
      language_codes
      llmWarningCount
      processingMode
      lastSuccessfulCompletedAt
      createdAt
      updatedAt
    }
  }
`;

const ALL_COUNTRIES = gql`
  query AllCountries {
    allCountries
  }
`;

const UPDATE_NOTIFICATION_WINDOW = gql`
  mutation UpdateNotificationWindow($input: UpdateNotificationWindowInput!) {
    updateNotificationWindow(input: $input) {
      _id
      preferredNotificationWindow
      notificationsEnabled
      expoPushToken
      onboardingStage
      createdAt
      updatedAt
    }
  }
`;

const UPDATE_EXPO_PUSH_TOKEN = gql`
  mutation UpdateExpoPushToken($input: UpdateExpoPushTokenInput!) {
    updateExpoPushToken(input: $input) {
      _id
      preferredNotificationWindow
      notificationsEnabled
      expoPushToken
      onboardingStage
      createdAt
      updatedAt
    }
  }
`;

const DELETE_EXPO_PUSH_TOKEN = gql`
  mutation DeleteExpoPushToken($input: DeleteExpoPushTokenInput!) {
    deleteExpoPushToken(input: $input) {
      _id
      preferredNotificationWindow
      notificationsEnabled
      expoPushToken
      onboardingStage
      createdAt
      updatedAt
    }
  }
`;

const ADVANCE_ONBOARDING_STAGE = gql`
  mutation AdvanceOnboardingStage($userId: ID!, $stage: OnboardingStage!) {
    advanceOnboardingStage(userId: $userId, stage: $stage) {
      _id
      preferredNotificationWindow
      notificationsEnabled
      expoPushToken
      onboardingStage
      createdAt
      updatedAt
    }
  }
`;

const UPDATE_NOTIFICATIONS_ENABLED = gql`
  mutation UpdateNotificationsEnabled($input: UpdateNotificationsEnabledInput!) {
    updateNotificationsEnabled(input: $input) {
      _id
      notificationsEnabled
      updatedAt
    }
  }
`;

const UPDATE_PROCESSING_MODE = gql`
  mutation UpdateProcessingMode($input: UpdateProcessingModeInput!) {
    updateProcessingMode(input: $input) {
      _id
      processingMode
      updatedAt
    }
  }
`;


const UPDATE_USER_CONFIG = gql`
  mutation UpdateUserConfig($input: UpdateUserConfigInput!) {
    updateUserConfig(input: $input) {
      _id
      language_codes
      updatedAt
    }
  }
`;

// Server-authoritative LLM warning. Increments llmWarningCount; at count >= 3
// also sets blockedByLlm + blockedByLlmReason. Returns the updated persona.
// Selects the full field set persistUserPersona needs so the local cache stays
// authoritative after a warning.
const ISSUE_LLM_WARNING = gql`
  mutation IssueLlmWarning($input: IssueLlmWarningInput!) {
    issueLlmWarning(input: $input) {
      _id
      userId
      blockedByLlm
      blockedByLlmReason
      llmWarningCount
      processingMode
      onboardingStage
      notificationsEnabled
      preferredNotificationWindow
      language_codes
      createdAt
      updatedAt
    }
  }
`;

const REQUEST_UNBLOCK = gql`
  mutation RequestUnblock($input: RequestUnblockInput!) {
    requestUnblock(input: $input) {
      _id
      userId
      feedback
      blockedReasonSnapshot
      status
      createdAt
      updatedAt
    }
  }
`;

const GET_UNBLOCK_REQUEST_STATUS = gql`
  query UnblockRequestStatus($userId: ID!) {
    unblockRequestStatus(userId: $userId) {
      _id
      userId
      feedback
      blockedReasonSnapshot
      status
      createdAt
      updatedAt
    }
  }
`;

// Types

export interface UserTopic {
    _id: string;
    news_topic_text: string;
    cluster_count: number;
    article_count: number;
    is_canonical: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface UserPersona {
    _id: string;
    userId: string;
    userTopics?: UserTopic[] | null;
    preferredNotificationWindow: number[];
    notificationsEnabled: boolean;
    expoPushToken?: string | null;
    onboardingStage: OnboardingStage;
    blockedByLlm: boolean;
    blockedByLlmReason?: string | null;
    language_codes?: string[] | null;
    processingMode: ProcessingMode;
    llmWarningCount: number;
    lastSuccessfulCompletedAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface AllCountriesResponse {
    allCountries: string[];
}

export interface UpdateNotificationWindowResponse {
    updateNotificationWindow: UserPersona;
}

export interface UpdateExpoPushTokenResponse {
    updateExpoPushToken: UserPersona;
}

export interface DeleteExpoPushTokenResponse {
    deleteExpoPushToken: UserPersona;
}

export interface AdvanceOnboardingStageResponse {
    advanceOnboardingStage: UserPersona;
}

export interface UpdateProcessingModeResponse {
    updateProcessingMode: UserPersona;
}

export interface UpdateNotificationsEnabledResponse {
    updateNotificationsEnabled: UserPersona;
}


export interface UpdateUserConfigResponse {
    updateUserConfig: UserPersona;
}

export interface GetUserPersonaResponse {
    userPersonaByUserId: UserPersona | null;
}

// --- LLM warning / unblock-request types (hand-written; no codegen dependency,
// server schema for these lands in parallel) ---

export type UnblockRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface UnblockRequest {
    _id: string;
    userId: string;
    feedback: string;
    blockedReasonSnapshot?: string | null;
    status: UnblockRequestStatus;
    createdAt: string;
    updatedAt: string;
}

/** Single chat transcript entry sent with an unblock request (server input shape). */
export interface ChatMessageInput {
    role: string;
    content: string;
    createdAt: string;
}

export interface IssueLlmWarningResponse {
    issueLlmWarning: UserPersona;
}

export interface RequestUnblockResponse {
    requestUnblock: UnblockRequest;
}

export interface UnblockRequestStatusResponse {
    unblockRequestStatus: UnblockRequest | null;
}

// Account Service Class
export class AccountService {
    /**
     * Get user persona data
     */
    static async getUserPersona(userId: string): Promise<UserPersona | null> {
        try {
            const { data } = await client.query<GetUserPersonaResponse>({
                query: GET_USER_PERSONA,
                variables: { userId },
                fetchPolicy: 'network-only',
            });

            const userPersona = data?.userPersonaByUserId ?? null;
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'getUserPersona' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Get the user's onboarding stage. Returns NOTIFICATIONS for missing
     * personas or errors — i.e. start from the beginning.
     */
    static async getOnboardingStage(userId: string): Promise<OnboardingStage> {
        try {
            const userPersona = await this.getUserPersona(userId);
            return userPersona?.onboardingStage ?? OnboardingStage.Notifications;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'getOnboardingStage' },
                extra: { userId },
            });
            return OnboardingStage.Notifications;
        }
    }

    /**
     * Update notification window
     */
    private static async updateNotificationWindowMutation(userId: string, preferredNotificationWindow: number[]): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<UpdateNotificationWindowResponse>({
                mutation: UPDATE_NOTIFICATION_WINDOW,
                variables: {
                    input: {
                        userId,
                        preferredNotificationWindow,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.updateNotificationWindow;
            if (!userPersona) {
                throw new Error('Failed to update notification window - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'updateNotificationWindowMutation' },
                extra: { userId, preferredNotificationWindow },
            });
            throw error;
        }
    }

    /**
     * Update expo push token
     */
    static async updateExpoPushTokenMutation(userId: string, expoPushToken: string | null): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<UpdateExpoPushTokenResponse>({
                mutation: UPDATE_EXPO_PUSH_TOKEN,
                variables: {
                    input: {
                        userId,
                        expoPushToken,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.updateExpoPushToken;
            if (!userPersona) {
                throw new Error('Failed to update expo push token - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'updateExpoPushTokenMutation' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Delete expo push token
     */
    static async deleteExpoPushToken(userId: string): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<DeleteExpoPushTokenResponse>({
                mutation: DELETE_EXPO_PUSH_TOKEN,
                variables: {
                    input: {
                        userId,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.deleteExpoPushToken;
            if (!userPersona) {
                throw new Error('Failed to delete expo push token - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'deleteExpoPushToken' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Get all available countries (ISO Alpha-3 codes)
     */
    static async getAllCountries(): Promise<string[]> {
        try {
            const { data } = await client.query<AllCountriesResponse>({
                query: ALL_COUNTRIES,
                fetchPolicy: 'network-only',
            });

            return data?.allCountries ?? [];
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'getAllCountries' },
            });
            throw error;
        }
    }


    /**
     * Update notification preferences
     */
    static async updateNotificationPreferences(
        userId: string,
        preferredNotificationWindow: number[],
    ): Promise<UserPersona> {
        return this.updateNotificationWindowMutation(userId, preferredNotificationWindow);
    }

    /**
     * Advance the user's onboarding stage. Server enforces monotonic
     * progression — sending a lower or equal stage is a no-op.
     */
    static async advanceOnboardingStage(
        userId: string,
        stage: OnboardingStage,
    ): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<AdvanceOnboardingStageResponse>({
                mutation: ADVANCE_ONBOARDING_STAGE,
                variables: {
                    userId,
                    stage,
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.advanceOnboardingStage;
            if (!userPersona) {
                throw new Error('Failed to advance onboarding stage - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'advanceOnboardingStage' },
                extra: { userId, stage },
            });
            throw error;
        }
    }

    /**
     * Toggle user-visible notifications (OS alerts, banners, sounds).
     * Independent of expoPushToken — silent result-ready pushes keep working
     * regardless of this flag.
     */
    static async updateNotificationsEnabled(userId: string, enabled: boolean): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<UpdateNotificationsEnabledResponse>({
                mutation: UPDATE_NOTIFICATIONS_ENABLED,
                variables: { input: { userId, enabled } },
            });
            if (error) throw error;
            const userPersona = data?.updateNotificationsEnabled;
            if (!userPersona) {
                throw new Error('Failed to update notifications enabled flag - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'updateNotificationsEnabled' },
                extra: { userId, enabled },
            });
            throw error;
        }
    }

    /**
     * Switch the user's Mera Protocol processing mode between on-device and
     * cloud (E2EE) inference.
     */
    static async updateProcessingMode(userId: string, mode: ProcessingMode): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<UpdateProcessingModeResponse>({
                mutation: UPDATE_PROCESSING_MODE,
                variables: {
                    input: {
                        userId,
                        mode,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.updateProcessingMode;
            if (!userPersona) {
                throw new Error('Failed to update processing mode - no data returned');
            }

            try {
                await client.cache.reset();
            } catch (cacheError) {
                logger.captureException(cacheError, {
                    tags: { service: 'account-service', method: 'updateProcessingMode', type: 'cache-reset' },
                });
            }

            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'updateProcessingMode' },
                extra: { userId, mode },
            });
            throw error;
        }
    }

    /**
     * Update user config (language_codes).
     * Used by on-device chat agent — these are settings, not PII.
     */
    static async updateUserConfig(
        userId: string,
        config: { language_codes?: string[] },
    ): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<UpdateUserConfigResponse>({
                mutation: UPDATE_USER_CONFIG,
                variables: {
                    input: {
                        userId,
                        ...config,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.updateUserConfig;
            if (!userPersona) {
                throw new Error('Failed to update user config - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'updateUserConfig' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Issue a server-authoritative LLM warning. Increments llmWarningCount and,
     * at count >= 3, blocks the user. Returns the updated persona so callers can
     * refresh their local cache.
     */
    static async issueLlmWarning(userId: string, reason: string): Promise<UserPersona> {
        try {
            const { data, error } = await client.mutate<IssueLlmWarningResponse>({
                mutation: ISSUE_LLM_WARNING,
                variables: { input: { userId, reason } },
            });
            if (error) {
                throw error;
            }
            const userPersona = data?.issueLlmWarning;
            if (!userPersona) {
                throw new Error('Failed to issue LLM warning - no data returned');
            }
            return userPersona;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'issueLlmWarning' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Submit an unblock request with the user's feedback and the chat transcript
     * that led to the block. Server rejects (throws) if the user isn't blocked or
     * already has a PENDING request.
     */
    static async requestUnblock(params: {
        userId: string;
        feedback: string;
        chatHistory: ChatMessageInput[];
    }): Promise<UnblockRequest> {
        const { userId, feedback, chatHistory } = params;
        try {
            const { data, error } = await client.mutate<RequestUnblockResponse>({
                mutation: REQUEST_UNBLOCK,
                variables: { input: { userId, feedback, chatHistory } },
            });
            if (error) {
                throw error;
            }
            const request = data?.requestUnblock;
            if (!request) {
                throw new Error('Failed to request unblock - no data returned');
            }
            return request;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'requestUnblock' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Fetch the current PENDING unblock request for a user, or null if none.
     */
    static async getPendingUnblockRequest(userId: string): Promise<UnblockRequest | null> {
        try {
            const { data } = await client.query<UnblockRequestStatusResponse>({
                query: GET_UNBLOCK_REQUEST_STATUS,
                variables: { userId },
                fetchPolicy: 'network-only',
            });
            return data?.unblockRequestStatus ?? null;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'getPendingUnblockRequest' },
                extra: { userId },
            });
            throw error;
        }
    }

}

export default AccountService;
