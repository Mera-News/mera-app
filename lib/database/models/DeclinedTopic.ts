import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * A topic the user explicitly said No to (schema v55).
 *
 * User-owned, permanent and backed up. This is a preference, not a cache:
 * losing it means the persona agent re-proposes interests the user already
 * rejected. Removing one is an explicit act (`removeDecline`), and doing so
 * only stops the decline suppressing future proposals — it does NOT resurrect
 * the topic row, which was destroyed when the delete committed.
 *
 * Device-only and never reported. No collection may link a user to a topic
 * server-side, and this is product state rather than behavioural
 * instrumentation.
 *
 * `text` vs `normalizedText`: the first is the display form the "Topics you
 * removed" list renders, the second is the dedup and match key that topic
 * generation filters candidates against. Keying on the normalized form alone
 * would show the user lowercased, whitespace-collapsed strings back.
 */
export default class DeclinedTopic extends Model {
  static table = 'declined_topics';

  @text('text') text!: string;
  @text('normalized_text') normalizedText!: string;
  /** The fact this topic belonged to, when it had one. Location and
   *  tracked-story topics carry no fact, so NULL is a first-class value. */
  @field('source_fact_id') sourceFactId!: string | null;
  @date('created_at') createdAt!: Date;
}
