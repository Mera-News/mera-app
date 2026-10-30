import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

import { normalizeMustMatch } from '@/lib/news-harness';

/**
 * Persona v3 weighted granular topic — replaces the `fact.metadata.topics`
 * string list. Long-lived, user-owned. `normalized_text` (lowercase/trim) is
 * the dedup + article-match key. Semantics:
 *   active & weight>0 → retrieved + positively scored
 *   active & weight≤0 → not retrieved; demotes at scoring if the article matches
 *   suppressed        → hard filter
 *   retired           → dedup/history only
 */
export type TopicStatus = 'active' | 'suppressed' | 'retired';
export type TopicProvenance =
  | 'llm'
  | 'user'
  | 'feedback'
  | 'migration'
  | 'exploration'
  // A topic minted when the user taps "Track story" — followed continuously
  // server-side; retired on untrack (see lib/tracking/track-actions.ts).
  | 'tracked'
  // Minted by the deferred combination pass (a fact read against the others).
  // The pass diffs ONLY these rows; every other provenance is out of its reach.
  | 'combo';

export default class Topic extends Model {
  static table = 'topics';

  @field('fact_id') factId!: string | null;
  @text('text') text!: string;
  @text('normalized_text') normalizedText!: string;
  @field('weight') weight!: number;
  @field('status') status!: TopicStatus;
  @field('provenance') provenance!: TopicProvenance;
  @field('high_priority') highPriority!: boolean;
  @field('location_id') locationId!: string | null;
  @field('last_signal_at') lastSignalAt!: number | null;
  /**
   * Staged for deletion (v55). Non-null ⇒ the row still EXISTS but no live read
   * may return it, which is what lets the 5s undo survive the card unmounting,
   * a tab switch and a process kill.
   *
   * NOT a fourth `TopicStatus`: staging is orthogonal to
   * active/suppressed/retired, and folding it in would lose the status the row
   * must be restored to on undo.
   */
  @field('pending_delete_at') pendingDeleteAt!: number | null;
  /** Raw JSON string[] of a followed story's must-match names (v57). Read
   *  through `mustMatch`; null on every row followed before v57. */
  @field('must_match_json') mustMatchJson!: string | null;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  /** The must-match names, normalized; [] when absent or unparseable. */
  get mustMatch(): string[] {
    if (!this.mustMatchJson) return [];
    try {
      return normalizeMustMatch(JSON.parse(this.mustMatchJson));
    } catch {
      return [];
    }
  }
}
