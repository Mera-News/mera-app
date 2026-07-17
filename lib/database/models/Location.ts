import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 role-tagged place entity. Long-lived, user-owned. Never sent in
 * retrieval (privacy-lean) — all geo matching happens on-device. Ordered by
 * `weight` desc. `pinned_for_weather` is reserved for a future WeatherKit
 * widget and unused by scoring.
 */
export type LocationRole =
  | 'home'
  | 'travel'
  | 'family'
  | 'partner_family'
  | 'interest';
export type LocationProvenance = 'llm' | 'user' | 'feedback' | 'migration';

export default class Location extends Model {
  static table = 'locations';

  @text('city') city!: string | null;
  @text('region') region!: string | null;
  @field('country_code') countryCode!: string;
  @field('role') role!: LocationRole;
  @field('weight') weight!: number;
  @field('valid_until') validUntil!: number | null;
  @field('pinned_for_weather') pinnedForWeather!: boolean;
  @field('provenance') provenance!: LocationProvenance;
  @field('source_fact_id') sourceFactId!: string | null;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
