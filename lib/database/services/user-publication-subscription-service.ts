import { Q } from '@nozbe/watermelondb';

import database from '../index';
import UserPublicationSubscriptionModel, {
  type UserPublicationSubscriptionStatus,
} from '../models/UserPublicationSubscription';

const subscriptionsCollection = database.get<UserPublicationSubscriptionModel>(
  'user_publication_subscriptions',
);

/**
 * The one normalisation every publication-name comparison in this feature
 * uses. Deliberately identical to
 * `publication-preference-service.normalizePublicationName` and to
 * `persona-agent-core.normalizePublicationNameForMatch`: a subscription only
 * ever fires on exact normalised-name equality, so the three must agree
 * character for character. It is duplicated rather than imported because both
 * existing copies sit above this layer (`lib/news-harness` imports downward
 * into `lib/database`, never the reverse) and one shared line is cheaper than
 * the inversion.
 */
export function normalizeSubscriptionName(s: string): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Reads `source_names_json` without ever throwing on the render path. A
 * malformed or truncated blob degrades to "this subscription matches nothing"
 * rather than taking down article detail, which is the right failure: the set
 * is refreshed opportunistically every time the subscriptions screen loads.
 */
export function parseSourceNames(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

export interface UpsertSubscriptionInput {
  readonly publisherId: string;
  readonly publisherName: string;
  readonly countryCode: string;
  readonly subscriptionUri?: string | null;
  /** Every source name belonging to this publisher, raw. Normalised here. */
  readonly sourceNames: readonly string[];
}

/**
 * Adds or reactivates a subscription, keyed on `publisher_id`.
 *
 * Keyed on the id and not the name on purpose: the name is what the user
 * reads, the id is what the publisher record IS, and a publisher that gets
 * renamed server-side must not turn into a second row.
 *
 * Re-subscribing after a cancel or a decline reuses the existing row and
 * refreshes the source-name set, so the set never goes stale across a
 * cancel/re-add cycle.
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput,
): Promise<UserPublicationSubscriptionModel> {
  const existing = await findByPublisherId(input.publisherId);
  const sourceNamesJson = JSON.stringify(
    Array.from(new Set(input.sourceNames.map(normalizeSubscriptionName).filter(Boolean))),
  );

  return database.write(async () => {
    const now = new Date();
    if (existing) {
      await existing.update((r) => {
        r.publisherName = input.publisherName.trim();
        r.publisherNameNorm = normalizeSubscriptionName(input.publisherName);
        r.countryCode = input.countryCode;
        r.subscriptionUri = input.subscriptionUri ?? null;
        r.sourceNamesJson = sourceNamesJson;
        // A re-subscribe clears a previous 'declined' as well as a
        // 'cancelled' — saying yes is a stronger signal than the No that
        // silenced the prompt.
        r.status = 'active';
        r.subscribedAt = now;
        r.updatedAt = now;
      });
      return existing;
    }
    return subscriptionsCollection.create((r) => {
      r.publisherId = input.publisherId;
      r.publisherName = input.publisherName.trim();
      r.publisherNameNorm = normalizeSubscriptionName(input.publisherName);
      r.countryCode = input.countryCode;
      r.subscriptionUri = input.subscriptionUri ?? null;
      r.sourceNamesJson = sourceNamesJson;
      r.status = 'active';
      r.subscribedAt = now;
      r.createdAt = now;
      r.updatedAt = now;
    });
  });
}

/** Any row for this publisher, whatever its status. */
export async function findByPublisherId(
  publisherId: string,
): Promise<UserPublicationSubscriptionModel | null> {
  const rows = await subscriptionsCollection
    .query(Q.where('publisher_id', publisherId))
    .fetch();
  return rows[0] ?? null;
}

/** Active subscriptions only — what the list and all matching consume. */
export async function getActive(): Promise<UserPublicationSubscriptionModel[]> {
  return subscriptionsCollection.query(Q.where('status', 'active')).fetch();
}

/** Reactive query of active subscriptions. */
export function observeActive() {
  return subscriptionsCollection.query(Q.where('status', 'active')).observe();
}

/** Soft delete, mirroring `publication_preferences`. History is preserved. */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  const record = await subscriptionsCollection.find(subscriptionId);
  await database.write(async () => {
    await record.update((r) => {
      r.status = 'cancelled';
      r.updatedAt = new Date();
    });
  });
}

/**
 * Records that the user answered No to "Did you subscribe to X?" so the
 * prompt never fires for this publisher again.
 *
 * A decline is written as a ROW rather than a settings key because the
 * question is per publisher and the answer has to survive alongside the
 * subscriptions it sits next to. It never overwrites an active subscription:
 * a user who already subscribes and then dismisses a stray prompt must not
 * lose the subscription.
 */
export async function declinePublisher(input: {
  readonly publisherId: string;
  readonly publisherName: string;
  readonly countryCode: string;
  readonly subscriptionUri?: string | null;
}): Promise<void> {
  const existing = await findByPublisherId(input.publisherId);
  if (existing?.status === 'active') return;

  await database.write(async () => {
    const now = new Date();
    if (existing) {
      await existing.update((r) => {
        r.status = 'declined';
        r.updatedAt = now;
      });
      return;
    }
    await subscriptionsCollection.create((r) => {
      r.publisherId = input.publisherId;
      r.publisherName = input.publisherName.trim();
      r.publisherNameNorm = normalizeSubscriptionName(input.publisherName);
      r.countryCode = input.countryCode;
      r.subscriptionUri = input.subscriptionUri ?? null;
      r.sourceNamesJson = '[]';
      r.status = 'declined';
      r.subscribedAt = now;
      r.createdAt = now;
      r.updatedAt = now;
    });
  });
}

/** True when the prompt has already been answered for this publisher. */
export async function hasAnsweredForPublisher(publisherId: string): Promise<boolean> {
  const existing = await findByPublisherId(publisherId);
  return existing != null && (existing.status === 'active' || existing.status === 'declined');
}

/**
 * Refreshes the stored source-name set for a publisher already subscribed.
 * Called opportunistically when the subscriptions screen loads, so a
 * publisher that gained a feed since the user subscribed starts matching
 * without them doing anything.
 *
 * A no-op when the set is unchanged, so the screen's load does not churn
 * `updated_at` on every mount.
 */
export async function refreshSourceNames(
  publisherId: string,
  sourceNames: readonly string[],
): Promise<boolean> {
  const existing = await findByPublisherId(publisherId);
  if (!existing || existing.status !== 'active') return false;

  const next = Array.from(
    new Set(sourceNames.map(normalizeSubscriptionName).filter(Boolean)),
  );
  const current = parseSourceNames(existing.sourceNamesJson);
  if (next.length === current.length && next.every((n) => current.includes(n))) return false;

  await database.write(async () => {
    await existing.update((r) => {
      r.sourceNamesJson = JSON.stringify(next);
      r.updatedAt = new Date();
    });
  });
  return true;
}

/**
 * The union of every active subscription's source names, normalised.
 *
 * This is THE set all article matching runs against. Never match on
 * `publisherNameNorm`: an article's `publication_name` is the SOURCE's name,
 * which is frequently not the publisher's.
 */
export async function getSubscribedSourceNameSet(): Promise<Set<string>> {
  const rows = await getActive();
  const set = new Set<string>();
  for (const row of rows) {
    for (const name of parseSourceNames(row.sourceNamesJson)) set.add(name);
  }
  return set;
}

/** Convenience wrapper for a single article's `publication_name`. */
export async function isSubscribedPublicationName(
  publicationName: string | null | undefined,
): Promise<boolean> {
  if (!publicationName) return false;
  const set = await getSubscribedSourceNameSet();
  return set.has(normalizeSubscriptionName(publicationName));
}

/** Active subscriptions keyed by every source name they cover. */
export async function getSubscriptionBySourceName(): Promise<
  Map<string, UserPublicationSubscriptionModel>
> {
  const rows = await getActive();
  const map = new Map<string, UserPublicationSubscriptionModel>();
  for (const row of rows) {
    for (const name of parseSourceNames(row.sourceNamesJson)) {
      // First writer wins. Two publishers claiming the same source name is a
      // catalogue fault, not something to resolve arbitrarily at render time.
      if (!map.has(name)) map.set(name, row);
    }
  }
  return map;
}

export type { UserPublicationSubscriptionStatus };
