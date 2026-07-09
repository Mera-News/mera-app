import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

/**
 * A single durable chat message belonging to a Conversation.
 *
 * `toolCallsJson` and `suggestedOptionsJson` are JSON-encoded strings parsed by
 * the conversation service (kept as raw strings on the model so a corrupt value
 * can be tolerated at read time rather than throwing inside a decorator).
 */
export default class Message extends Model {
  static table = 'messages';

  static associations = {
    conversations: { type: 'belongs_to' as const, key: 'conversation_id' },
  } as const;

  @field('conversation_id') conversationId!: string;
  @field('role') role!: string;
  @field('content') content!: string;
  @field('suggested_options_json') suggestedOptionsJson!: string | null;
  @field('tool_calls_json') toolCallsJson!: string | null;
  @date('created_at') createdAt!: Date;
}
