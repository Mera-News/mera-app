import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * One fact check the user asked for, stored on THIS device.
 *
 * The check is asynchronous: the app fires the request and stops (there is no
 * client poll any more — see `lib/fact-check/use-fact-check.ts`), and the
 * answer typically lands minutes later, via push, long after the reader closed
 * the article. This row is where it lands, and it is what the Dashboard's
 * "Fact checks" block and the /logged-in/fact-checks list read.
 *
 * `payloadJson` holds the WHOLE server row — claims, citations and the
 * `checkedBy` organisations — serialized verbatim. `status`/`verdict` are
 * mirrored out of it so a list can be sorted and filtered without parsing every
 * payload.
 */
export default class FactCheckRecord extends Model {
  static table = 'fact_checks';

  @field('article_id') articleId!: string;
  @field('fact_check_id') factCheckId!: string;
  @text('article_title') articleTitle!: string | null;
  @field('status') status!: string;
  @field('verdict') verdict!: string | null;
  @text('payload_json') payloadJson!: string;
  @date('requested_at') requestedAt!: Date;
  @date('resolved_at') resolvedAt!: Date | null;

  /**
   * v52 — per-claim identity.
   *
   * `claim` is the verbatim assertion the user picked out of the claim
   * picker's options; `claimKey` is its normalised hash and the second half of
   * the upsert key `(article_id, claim_key)`.
   *
   * BOTH ARE NULL ON A v51 ROW, and that null is meaningful rather than
   * missing: it marks a legacy whole-article check, which keeps its own slot
   * because a keyed lookup can never match it.
   */
  @text('claim') claim!: string | null;
  @field('claim_key') claimKey!: string | null;
}
