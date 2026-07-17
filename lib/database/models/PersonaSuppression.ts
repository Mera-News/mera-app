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
}
