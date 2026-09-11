import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * A publication the user has told us they pay for. Long-lived, user-owned,
 * and DEVICE-ONLY — there is no server-side `userId -> publisher` row anywhere
 * in this feature, by decision.
 *
 * Two things this row is for: prioritising the publication in scoring (through
 * the existing `publication_preferences` machinery, not a new axis), and
 * surfacing "From your subscriptions" on article detail.
 */

/**
 * `'declined'` is a resting state in its own right, not a deleted
 * subscription. It records that the user answered No to the "Did you subscribe
 * to X?" prompt, so the prompt never fires for that publisher again. Only
 * `'active'` rows match articles or render in the list.
 */
export type UserPublicationSubscriptionStatus = 'active' | 'cancelled' | 'declined';

export default class UserPublicationSubscription extends Model {
  static table = 'user_publication_subscriptions';

  /** Mongo `_id` of the `NewsPublisher`. The stable identity of the row. */
  @text('publisher_id') publisherId!: string;

  /** Display name, as the publisher record spells it. */
  @text('publisher_name') publisherName!: string;

  /** `publisherName` through the shared publication-name normalisation. */
  @text('publisher_name_norm') publisherNameNorm!: string;

  /**
   * Whatever the publisher record carries. Usually ISO alpha-3, but not
   * always: "The Next Web" is `'GLOBAL'`. Never assume three letters.
   */
  @text('country_code') countryCode!: string;

  /**
   * The publisher's own subscribe/pricing page, snapshotted at add time.
   * NULL is a first-class value meaning the publisher has no consumer
   * subscription product, not missing data.
   */
  @field('subscription_uri') subscriptionUri!: string | null;

  /**
   * JSON `string[]` of every NORMALISED source name belonging to this
   * publisher. This is what article matching runs against, never
   * `publisherNameNorm`.
   *
   * Articles carry a bare `publication_name`, which is the SOURCE's name, and
   * a source's name is not guaranteed equal to its publisher's name. Matching
   * on the publisher name alone silently misses coverage, which is the whole
   * reason this column exists. Read it through
   * `user-publication-subscription-service.parseSourceNames`, which tolerates
   * a malformed blob rather than throwing on the render path.
   */
  @text('source_names_json') sourceNamesJson!: string;

  @field('status') status!: UserPublicationSubscriptionStatus;

  /** When the user told us they subscribe. Survives a cancel and re-add. */
  @date('subscribed_at') subscribedAt!: Date;

  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;
}
