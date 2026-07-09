import { Model } from '@nozbe/watermelondb';
import { field, date, children } from '@nozbe/watermelondb/decorators';
import type { Query } from '@nozbe/watermelondb';
import type Message from './Message';

/**
 * A durable chat session. `surface` records where the conversation happened
 * (ONBOARDING | CONFIG). Long-lived, user-owned state — never wiped on resync.
 */
export default class Conversation extends Model {
  static table = 'conversations';

  static associations = {
    messages: { type: 'has_many' as const, foreignKey: 'conversation_id' },
  } as const;

  @field('surface') surface!: string;
  @date('created_at') createdAt!: Date;

  @children('messages') messages!: Query<Message>;
}
