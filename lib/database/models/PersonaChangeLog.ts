import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 audit / revert log — one row per persona mutation. `action_json`
 * holds enough state ({ before, after, targetId, delta }) to invert the
 * action. Long-lived, user-owned.
 */
export type PersonaChangeLogSource =
  | 'nudge'
  | 'chat'
  | 'feedback'
  | 'digest'
  | 'slider'
  | 'migration'
  // Automatic, non-user-initiated derivation (the geo-derivation sweep). The
  // audit screen has no label for it yet, so it renders via the 'unknown'
  // fallback ("System") — see components/custom/persona-audit/action-display.
  | 'llm'
  | 'user';

export default class PersonaChangeLog extends Model {
  static table = 'persona_change_log';

  @field('action_type') actionType!: string;
  @text('action_json') actionJson!: string;
  @field('source') source!: PersonaChangeLogSource;
  @text('summary') summary!: string;
  @field('reverted') reverted!: boolean;
  @date('created_at') createdAt!: Date;
}
