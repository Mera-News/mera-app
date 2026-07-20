import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

/**
 * A natural-language persona summary string (schema v38) — a human-readable
 * one-liner derived from the structured on-device persona, linked back to the
 * facts/topics that produced it.
 *
 * Long-lived, user-owned state. A later wave builds the generation pipeline;
 * this wave only stands up the table + model ("migrate never wipe" category).
 * Nothing reads these rows yet.
 */
export default class PersonaSummaryString extends Model {
  static table = 'persona_summary_strings';

  @field('text') text!: string;
  @field('linked_fact_ids_json') linkedFactIdsJson!: string;
  @field('linked_topic_ids_json') linkedTopicIdsJson!: string;
  @date('generated_at') generatedAt!: Date;
  @field('persona_version') personaVersion!: string | null;
  @field('stale') stale!: boolean | null;
}
