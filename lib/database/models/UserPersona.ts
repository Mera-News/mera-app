import { Model } from '@nozbe/watermelondb';
import { field, json, date, children } from '@nozbe/watermelondb/decorators';
import type { Query } from '@nozbe/watermelondb';
import type UserTopic from './UserTopic';

const sanitizeJsonArray = (raw: unknown) => (Array.isArray(raw) ? raw : []);

export default class UserPersona extends Model {
  static table = 'user_personas';

  static associations = {
    user_topics: { type: 'has_many' as const, foreignKey: 'user_persona_id' },
  } as const;

  @field('server_id') serverId!: string;
  @field('user_id') userId!: string;
  @field('processing_mode') processingMode!: string;
  @field('onboarding_stage') onboardingStage!: string;
  @field('blocked_by_llm') blockedByLlm!: boolean;
  @field('blocked_by_llm_reason') blockedByLlmReason!: string | null;
  @field('llm_warning_count') llmWarningCount!: number;
  @field('notifications_enabled') notificationsEnabled!: boolean;
  @json('preferred_notification_window_json', sanitizeJsonArray) preferredNotificationWindow!: number[];
  @json('language_codes_json', sanitizeJsonArray) languageCodes!: string[] | null;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  @children('user_topics') userTopics!: Query<UserTopic>;
}
