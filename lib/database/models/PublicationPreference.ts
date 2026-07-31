import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 preferred / blocked publication. Long-lived, user-owned. Matched
 * by `publication_name`. Weights are only ever written explicitly (no implicit
 * dwell signal): >0 boost, <0 dampen, -1 ≈ block.
 */
export type PublicationPreferenceStatus = 'active' | 'retired';
export type PublicationPreferenceProvenance = 'user' | 'feedback' | 'migration';

/**
 * source-pref v47 (D2/D6). The discriminator that turns a row from a
 * NAMED-PUBLICATION preference into a LIVE SCOPE: `scopeKind === 'country'`
 * means the row matches any source whose `country_code` equals `scopeValue`
 * (ISO alpha-3), evaluated at render time rather than expanded into rows.
 *
 * `null`/undefined `scopeKind` ⇒ a named-publication row (every pre-v47 row).
 * Only `'country'` exists: `category` is deliberately NOT a scope kind — it is
 * the PUBLICATION's category and 63% of sources share two generic values, so
 * it cannot express "sources like this one".
 */
export type SourceScopeKind = 'country';

export default class PublicationPreference extends Model {
  static table = 'publication_preferences';

  /** Display label. For a scope row this is the human name ("India"), NOT a
   *  publication — every name-matching site must skip rows with a `scopeKind`. */
  @text('publication_name') publicationName!: string;
  @field('source_country_code') sourceCountryCode!: string | null;
  @field('scope_kind') scopeKind!: SourceScopeKind | null;
  @field('scope_value') scopeValue!: string | null;
  @field('weight') weight!: number;
  @field('status') status!: PublicationPreferenceStatus;
  @field('provenance') provenance!: PublicationPreferenceProvenance;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
