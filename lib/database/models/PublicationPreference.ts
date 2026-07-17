import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 preferred / blocked publication. Long-lived, user-owned. Matched
 * by `publication_name`. Weights are only ever written explicitly (no implicit
 * dwell signal): >0 boost, <0 dampen, -1 ≈ block.
 */
export type PublicationPreferenceStatus = 'active' | 'retired';
export type PublicationPreferenceProvenance = 'user' | 'feedback' | 'migration';

export default class PublicationPreference extends Model {
  static table = 'publication_preferences';

  @text('publication_name') publicationName!: string;
  @field('source_country_code') sourceCountryCode!: string | null;
  @field('weight') weight!: number;
  @field('status') status!: PublicationPreferenceStatus;
  @field('provenance') provenance!: PublicationPreferenceProvenance;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
