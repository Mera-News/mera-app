import { gql } from '@apollo/client';
import client from './apollo-client';
import type {
    SubmittedUserTopic,
    SubmitUserTopicsResponse as SubmitUserTopicsResult,
} from './generated/graphql-types';
import { OnboardingStage, ProcessingMode } from './generated/graphql-types';
import logger from './logger';

export type { SubmittedUserTopic, SubmitUserTopicsResult };

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

const WITHDRAW_USER_TOPICS = gql`
  mutation WithdrawUserTopics($input: WithdrawUserTopicsInput!) {
    withdrawUserTopics(input: $input) {
      success
      removedCount
    }
  }
`;

const DELETE_ALL_USER_TOPICS = gql`
  mutation DeleteAllUserTopics($userId: ID!) {
    deleteAllUserTopics(userId: $userId) {
      success
      removedCount
    }
  }
`;

const DELETE_ALL_ARTICLE_SUGGESTIONS = gql`
  mutation DeleteAllArticleSuggestions($userId: ID!) {
    deleteAllArticleSuggestions(userId: $userId) {
      success
      removedCount
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

const SUBMIT_USER_TOPICS = gql`
  mutation SubmitUserTopics($input: SubmitUserTopicsInput!) {
    submitUserTopics(input: $input) {
      success
      message
      topics {
        topicId
        sourceFactLocalId
        text
      }
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

export interface WithdrawUserTopicsResponse {
    withdrawUserTopics: {
        success: boolean;
        removedCount: number;
    };
}

export interface DeleteAllUserTopicsResponse {
    deleteAllUserTopics: {
        success: boolean;
        removedCount: number;
    };
}

export interface DeleteAllArticleSuggestionsResponse {
    deleteAllArticleSuggestions: {
        success: boolean;
        removedCount: number;
    };
}

export interface AdvanceOnboardingStageResponse {
    advanceOnboardingStage: UserPersona;
}

export interface SubmitUserTopicsResponse {
    submitUserTopics: SubmitUserTopicsResult;
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
     * Withdraw topic IDs from UserPersona on the server.
     * Used when deleting on-device facts to cascade-remove their generated topics.
     */
    static async withdrawUserTopics(userId: string, topicIds: string[]): Promise<WithdrawUserTopicsResponse['withdrawUserTopics']> {
        try {
            const { data, error } = await client.mutate<WithdrawUserTopicsResponse>({
                mutation: WITHDRAW_USER_TOPICS,
                variables: {
                    input: {
                        userId,
                        topicIds,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const result = data?.withdrawUserTopics;
            if (!result) {
                throw new Error('Failed to withdraw user topics - no data returned');
            }
            return result;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'withdrawUserTopics' },
                extra: { userId, topicIds },
            });
            throw error;
        }
    }

    /**
     * Delete every UserTopic on the server for this user. Cascades on the
     * server to TopicClusterLink + TopicArticleLink, and pulls the topic ids
     * out of every ArticleSuggestion.userTopicIds for the persona.
     */
    static async deleteAllUserTopics(userId: string): Promise<DeleteAllUserTopicsResponse['deleteAllUserTopics']> {
        try {
            const { data, error } = await client.mutate<DeleteAllUserTopicsResponse>({
                mutation: DELETE_ALL_USER_TOPICS,
                variables: { userId },
            });
            if (error) {
                throw error;
            }
            const result = data?.deleteAllUserTopics;
            if (!result) {
                throw new Error('Failed to delete all user topics - no data returned');
            }
            return result;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'deleteAllUserTopics' },
                extra: { userId },
            });
            throw error;
        }
    }

    /**
     * Delete every ArticleSuggestion on the server for this user.
     * Suggestions are leaf nodes — no further server-side cascade.
     */
    static async deleteAllArticleSuggestions(userId: string): Promise<DeleteAllArticleSuggestionsResponse['deleteAllArticleSuggestions']> {
        try {
            const { data, error } = await client.mutate<DeleteAllArticleSuggestionsResponse>({
                mutation: DELETE_ALL_ARTICLE_SUGGESTIONS,
                variables: { userId },
            });
            if (error) {
                throw error;
            }
            const result = data?.deleteAllArticleSuggestions;
            if (!result) {
                throw new Error('Failed to delete all article suggestions - no data returned');
            }
            return result;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'deleteAllArticleSuggestions' },
                extra: { userId },
            });
            throw error;
        }
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
     * Submit on-device-generated topics to the server.
     *
     * The mutation is synchronous: by the time it returns, each submitted
     * topic has a server-assigned id attached to the user's persona. Embedding
     * generation continues in the background. The returned `topics` array
     * gives us the (topicId, sourceFactLocalId, text) tuples we need to write
     * fact_topic_links locally with no race.
     */
    static async submitUserTopics(
        userId: string,
        topics: Array<{ text: string; sourceFactLocalId: string }>,
    ): Promise<SubmitUserTopicsResult> {
        try {
            const { data, error } = await client.mutate<SubmitUserTopicsResponse>({
                mutation: SUBMIT_USER_TOPICS,
                variables: {
                    input: {
                        userId,
                        topics,
                    },
                },
            });
            if (error) {
                throw error;
            }
            const result = data?.submitUserTopics;
            if (!result) {
                throw new Error('Failed to submit user topics - no data returned');
            }
            return result;
        } catch (error) {
            logger.captureException(error, {
                tags: { service: 'account-service', method: 'submitUserTopics' },
                extra: { userId, topicCount: topics.length },
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

}

export default AccountService;
