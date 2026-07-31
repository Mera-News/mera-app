import { Model } from '@nozbe/watermelondb';
import { field, text, json, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 negative preference / show-less escalation. Long-lived,
 * user-owned. `strength` ≥ 0.8 → hard filter, else a score penalty. Soft ones
 * decay via `expires_at`.
 */
export type PersonaSuppressionSource =
  | 'chat'
  | 'qa'
  | 'feedback'
  | 'digest'
  | 'user';
export type PersonaSuppressionStatus = 'active' | 'retired';

/**
 * What a suppression matches against (schema v46). A NULL `kind` column reads
 * as 'keyword' (see suppression-service.kindOf) so pre-v46 rows are unchanged.
 *
 *  - keyword     → normalized substring over title + description + entities
 *                  (the historical behaviour; driven by `keywords`)
 *  - category    → article.category, exact normalized equality
 *  - event_type  → article.eventType, exact normalized equality
 *  - entity      → any of article.entities, exact normalized equality
 *  - publication → article.publicationName, exact normalized equality
 *  - place       → any of article.geoTags (city/region/countryCode)
 *  - topic       → any matched topic's text, exact normalized equality
 *
 * Every kind except `keyword` compares against the single `value` column.
 */
export const SUPPRESSION_KINDS = [
  'keyword',
  'category',
  'event_type',
  'entity',
  'publication',
  'place',
  'topic',
] as const;

export type PersonaSuppressionKind = (typeof SUPPRESSION_KINDS)[number];

const sanitizeKeywords = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [];

export default class PersonaSuppression extends Model {
  static table = 'persona_suppressions';

  @text('pattern') pattern!: string;
  @json('keywords_json', sanitizeKeywords) keywords!: string[];
  @field('strength') strength!: number;
  @field('source') source!: PersonaSuppressionSource;
  @field('status') status!: PersonaSuppressionStatus;
  @field('expires_at') expiresAt!: number | null;
  @date('created_at') createdAt!: Date;
  /** v46. NULL ⇒ 'keyword' (resolve via suppression-service.kindOf). */
  @field('kind') kind!: PersonaSuppressionKind | null;
  /** v46. The token the non-keyword kinds compare against. NULL for keyword. */
  @field('value') value!: string | null;
}
