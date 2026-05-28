import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export default class SyncedSuggestionId extends Model {
  static table = 'synced_suggestion_ids';

  @field('fetched_at') fetchedAt!: number;
  @field('processed_at') processedAt!: number | null;
}
