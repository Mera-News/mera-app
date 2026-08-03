// Topic Service — WatermelonDB adapter for persona-v3 `topics`.
//
// Thin RN-coupled surface: create/read/observe + status & weight mutations.
// All bounded-mutation / rails logic (per-day budgets, HP_MULT, etc.) lives in
// the news-harness (later wave) — these are just the DB writers it delegates to.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type TopicModel from '../models/Topic';
import type { TopicProvenance, TopicStatus } from '../models/Topic';
import { planLlmTopicRows } from '../../news-harness/persona-management/topic-generation';
import { DEFAULT_HARNESS_CONFIG } from '../../news-harness/core/config';

const topicsCollection = database.get<TopicModel>('topics');

/** Lowercase + trim + collapse whitespace — the dedup + article-match key. */
export function normalizeTopicText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export interface CreateTopicInput {
  factId?: string | null;
  text: string;
  normalizedText?: string;
  weight?: number;
  status?: TopicStatus;
  provenance?: TopicProvenance;
  highPriority?: boolean;
  locationId?: string | null;
  lastSignalAt?: number | null;
}

/**
 * Batch-creates topic rows in a single write, with a **dedupe floor**.
 *
 * `normalized_text` is documented on the model as "the dedup + article-match
 * key", but this writer used to `prepareCreate` unconditionally — so any caller
 * that ran twice minted a second identical row. Duplicates are not cosmetic:
 * each one is independently retrieved and independently billed on every feed
 * sync.
 *
 * SEMANTICS — resolve-or-create, NOT filter. For each input, if a live row
 * already holds the same key, that row is RETURNED instead of a new one being
 * created. Callers therefore always get one row per input, in order, and never
 * an `undefined` hole. This matters: four call sites destructure
 * `const [created] = await createTopics([...])` and treat a missing row as a
 * hard failure — `persona-action-executor` would report "failed to create
 * topic" for a topic that exists, and `track-actions` /
 * `tracked-story-migrate-handler` would bind a tracked story to a NULL topic_id,
 * silently stopping that followed story from ever matching new articles. The
 * migrate handler's own comment already asks for these semantics ("Mint (or
 * resolve an existing) 'tracked' topic").
 *
 * KEY — `(normalized_text, fact_id)`, deliberately NOT `normalized_text` alone.
 * The same text under a DIFFERENT fact is not a duplicate: the hygiene
 * `duplicate_facts` detector finds near-duplicate facts precisely by looking for
 * one normalized text owned by ≥2 facts (`findTopicOverlapAcrossFacts`, which
 * skips `factId === null` and requires `factIds.size >= 2`). A global key would
 * collapse those rows and delete that signal.
 *
 * RETIRED ROWS ARE EXEMPT. A retired row is dedup/history only; re-minting its
 * text is how a caller legitimately revives an interest, and resurrecting the
 * retired row instead must stay an explicit `reactivate()` decision.
 */
export async function createTopics(inputs: CreateTopicInput[]): Promise<TopicModel[]> {
  if (inputs.length === 0) return [];

  // NUL separator, written as an ESCAPE so this file stays plain text (a literal
  // NUL byte in the source makes git treat it as binary and kills diff/blame).
  // NUL is the delimiter because it is the one byte that cannot occur in either
  // half: normalizeTopicText collapses to printable text, and ids are hex-ish.
  // A printable separator like ':' would let (factId 'a:b', text 'c') collide
  // with (factId 'a', text 'b:c') — do not "simplify" this.
  const keyOf = (factId: string | null, normalizedText: string) =>
    `${factId ?? ''}\x00${normalizedText}`;

  const normalizedInputs = inputs.map((input) => ({
    input,
    factId: input.factId ?? null,
    normalizedText: input.normalizedText ?? normalizeTopicText(input.text),
  }));

  // One query for every candidate text; filter to live (non-retired) rows.
  const distinctTexts = [...new Set(normalizedInputs.map((n) => n.normalizedText))];
  const existingRows = await topicsCollection
    .query(
      Q.where('normalized_text', Q.oneOf(distinctTexts)),
      Q.where('status', Q.notEq('retired')),
    )
    .fetch();

  const existingByKey = new Map<string, TopicModel>();
  for (const row of existingRows) {
    // Retired rows never block a create (see doc comment). Re-checked here and
    // not left to the query alone so the rule is explicit at the point it
    // matters — and so it holds regardless of what the query layer returns.
    if (row.status === 'retired') continue;
    const k = keyOf(row.factId ?? null, row.normalizedText);
    if (!existingByKey.has(k)) existingByKey.set(k, row);
  }

  // Resolve each input to an existing row, or claim it for creation. A repeated
  // key WITHIN one batch resolves to the single row this call creates for it.
  const results: (TopicModel | undefined)[] = new Array(inputs.length);
  const claimedBy = new Map<string, number>();
  const toCreate: { index: number; input: CreateTopicInput; normalizedText: string }[] = [];

  normalizedInputs.forEach(({ input, factId, normalizedText }, i) => {
    const k = keyOf(factId, normalizedText);
    const existing = existingByKey.get(k);
    if (existing) {
      results[i] = existing;
      return;
    }
    if (claimedBy.has(k)) return; // intra-batch duplicate — filled in below
    claimedBy.set(k, i);
    toCreate.push({ index: i, input, normalizedText });
  });

  if (toCreate.length > 0) {
    const created = await database.write(async () => {
      const now = new Date();
      const prepared = toCreate.map(({ input, normalizedText }) =>
        topicsCollection.prepareCreate((t) => {
          t.factId = input.factId ?? null;
          t.text = input.text;
          t.normalizedText = normalizedText;
          t.weight = input.weight ?? 0;
          t.status = input.status ?? 'active';
          t.provenance = input.provenance ?? 'user';
          t.highPriority = input.highPriority ?? false;
          t.locationId = input.locationId ?? null;
          t.lastSignalAt = input.lastSignalAt ?? null;
          t.createdAt = now;
          t.updatedAt = now;
        }),
      );
      await database.batch(prepared);
      return prepared;
    });

    toCreate.forEach(({ index }, n) => {
      results[index] = created[n];
    });
  }

  // Fill intra-batch duplicates from the row their key's claimant produced.
  normalizedInputs.forEach(({ factId, normalizedText }, i) => {
    if (results[i]) return;
    const claimant = claimedBy.get(keyOf(factId, normalizedText));
    if (claimant !== undefined) results[i] = results[claimant];
  });

  return results.filter((r): r is TopicModel => r !== undefined);
}

/** Returns all topic rows owned by a fact (any status). */
export async function getByFact(factId: string): Promise<TopicModel[]> {
  return topicsCollection.query(Q.where('fact_id', factId)).fetch();
}

/** Reactive query of a fact's topics — for the in-chat topic-review widget.
 *  `observeWithColumns`, not `observe()`: the widget's delete/undo flips the
 *  row's `status` in place, which never changes query MEMBERSHIP — a plain
 *  `observe()` stays silent and the card looks dead (the retire lands in the
 *  DB but the row never strikes through). */
export function observeByFact(factId: string) {
  return topicsCollection
    .query(Q.where('fact_id', factId))
    .observeWithColumns(['status']);
}

/**
 * Reactive query of the persona's NEGATIVE topics — the "things I don't want"
 * section of the Not-interested screen.
 *
 * Two disjoint populations, deliberately unioned:
 *   - `active` rows carrying a negative weight — a downrank the user can still
 *     see the effect of, and can dial back.
 *   - every `suppressed` row, at any weight — a suppressed topic is a hard
 *     "never show me this" and belongs in the list regardless of its number.
 * `retired` rows are excluded: they are dedup/history only and never scored.
 *
 * Sorted by weight ASCENDING, so the strongest dislikes surface first.
 */
export function observeNegative() {
  return topicsCollection
    .query(
      Q.or(
        Q.and(Q.where('status', 'active'), Q.where('weight', Q.lt(0))),
        Q.where('status', 'suppressed'),
      ),
      Q.sortBy('weight', Q.asc),
    )
    .observe();
}

/** Active topics (any weight). */
export async function getActive(): Promise<TopicModel[]> {
  return topicsCollection.query(Q.where('status', 'active')).fetch();
}

/** Persona-v3 active-topic snapshot for the fact-sectioned feed selector:
 *  the fields `resolveOwningFact` reads (topic → owning fact + effective
 *  weight). Only `active` topics own sections, so this loads just those. */
export interface ActiveTopicSnapshot {
  id: string;
  factId: string | null;
  weight: number;
  highPriority: boolean;
}

export async function getActiveTopicSnapshots(): Promise<ActiveTopicSnapshot[]> {
  const rows = await getActive();
  return rows.map((t) => ({
    id: t.id,
    factId: t.factId ?? null,
    weight: t.weight,
    highPriority: t.highPriority,
  }));
}

/** Persona-hygiene snapshot for one topic row (ALL statuses). Carries the
 *  fields the fact-hygiene analyzer reads: owning fact, normalized text (dupe
 *  key), weight, status, and last-signal (stale detector). Kept RN-free-shaped
 *  so the pure analyzer never touches a WatermelonDB model. */
export interface TopicHygieneSnapshot {
  id: string;
  factId: string | null;
  text: string;
  normalizedText: string;
  weight: number;
  status: TopicStatus;
  lastSignalAtMs: number | null;
}

/** All topic rows (any status) projected to the hygiene snapshot shape. */
export async function getAllTopicSnapshots(): Promise<TopicHygieneSnapshot[]> {
  const rows = await topicsCollection.query().fetch();
  return rows.map((t) => ({
    id: t.id,
    factId: t.factId ?? null,
    text: t.text,
    normalizedText: t.normalizedText,
    weight: t.weight,
    status: t.status,
    lastSignalAtMs: t.lastSignalAt ?? null,
  }));
}

/** Count of all topic rows (any status) — the gate for the sectioned feed:
 *  an empty topics table means the persona-v3 migration hasn't run yet, so the
 *  screen renders the legacy priority-bucket layout. */
export async function countAllTopics(): Promise<number> {
  return topicsCollection.query().fetchCount();
}

/** Resolve topic ids to the {id, weight} of the rows that still EXIST (any
 *  status). Missing / stale ids are silently dropped (`Q.oneOf` returns only
 *  present rows). Used by the persona-string sheet's importance stepper to keep
 *  only live topics and read their current weight for the level display. */
export async function getWeightsByIds(ids: string[]): Promise<{ id: string; weight: number }[]> {
  if (ids.length === 0) return [];
  const rows = await topicsCollection.query(Q.where('id', Q.oneOf(ids))).fetch();
  return rows.map((t) => ({ id: t.id, weight: t.weight }));
}

/**
 * Every normalized text currently on the device, ANY fact, ANY status, ANY
 * provenance — the exclusion set the fact-combination top-up plans against.
 *
 * Deliberately global and deliberately including retired and tracked rows:
 *  - a `tracked` collision would mint a metered row for a text a followed story
 *    already owns, silently making that story's articles billable again;
 *  - a `retired` collision would re-append, week after week, exactly what the
 *    sanity pass just persuaded the user to retire.
 *
 * Note this is WIDER than createTopics' own (normalized_text, fact_id) floor,
 * which must stay per-fact so the hygiene duplicate_facts detector can still see
 * one text owned by two facts.
 */
export async function getAllNormalizedTexts(): Promise<Set<string>> {
  const rows = await topicsCollection.query().fetch();
  return new Set(rows.map((t) => t.normalizedText));
}

/** Active-topic rows projected for the top-up planner (RN-free shape). */
export interface TopupTopicSnapshot {
  id: string;
  factId: string;
  text: string;
  createdAtMs: number;
  isActive: boolean;
}

/** Fact-owned topic rows (any status) for top-up candidate selection. */
export async function getTopupTopicSnapshots(): Promise<TopupTopicSnapshot[]> {
  const rows = await topicsCollection
    .query(Q.where('fact_id', Q.notEq(null)))
    .fetch();
  return rows.map((t) => ({
    id: t.id,
    factId: t.factId as string,
    text: t.text,
    createdAtMs: t.createdAt instanceof Date ? t.createdAt.getTime() : 0,
    isActive: t.status === 'active',
  }));
}

/**
 * Append top-up topics to a fact. APPEND-ONLY: no existing row is updated,
 * re-weighted, retired, or destroyed.
 *
 * Seeded at `topupTopicWeight` rather than the full `llmTopicWeight` — these are
 * speculative combinations the user never asked for, and the seed weight drives
 * per-topic retrieval depth, so a lower weight costs less quota per appended
 * topic. Provenance is `llm`: they are ordinary metered interest topics derived
 * from persona facts, and marking them `tracked` would grant quota-exempt
 * hydration for articles the user never followed.
 */
export async function appendTopupTopicsForFact(
  factId: string,
  planned: { text: string; normalizedText: string }[],
): Promise<TopicModel[]> {
  if (planned.length === 0) return [];
  return createTopics(
    planned.map((p) => ({
      factId,
      text: p.text,
      normalizedText: p.normalizedText,
      weight: DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight,
      status: 'active' as const,
      provenance: 'llm' as const,
      highPriority: false,
    })),
  );
}

/** All topics sharing a normalized text (dedup + cross-fact overlap detection). */
export async function getAllByNormalizedText(normalizedText: string): Promise<TopicModel[]> {
  return topicsCollection
    .query(Q.where('normalized_text', normalizeTopicText(normalizedText)))
    .fetch();
}

export async function setWeight(topicId: string, weight: number): Promise<void> {
  const clamped = Math.max(-1, Math.min(1, weight));
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.weight = clamped;
      t.updatedAt = new Date();
    });
  });
}

export async function setHighPriority(topicId: string, highPriority: boolean): Promise<void> {
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.highPriority = highPriority;
      t.updatedAt = new Date();
    });
  });
}

async function setStatus(topicId: string, status: TopicStatus): Promise<void> {
  const record = await topicsCollection.find(topicId);
  await database.write(async () => {
    await record.update((t) => {
      t.status = status;
      t.updatedAt = new Date();
    });
  });
}

/** Retire a topic (dedup/history only — never retrieved or scored). */
export async function retire(topicId: string): Promise<void> {
  await setStatus(topicId, 'retired');
}

/** Suppress a topic (hard filter). */
export async function suppress(topicId: string): Promise<void> {
  await setStatus(topicId, 'suppressed');
}

/** Reactivate a suppressed/retired topic. */
export async function reactivate(topicId: string): Promise<void> {
  await setStatus(topicId, 'active');
}

/** Every topic id currently on the device — the liveness set the suggestion
 *  purge screens against (see article-suggestion-service). Includes retired and
 *  suppressed rows on purpose: those still EXIST, so a suggestion matching one
 *  is stale, not orphaned, and must not be destroyed. */
export async function getAllTopicIds(): Promise<Set<string>> {
  const rows = await topicsCollection.query().fetch();
  return new Set(rows.map((t) => t.id));
}

/**
 * Startup repair: destroy topics whose owning fact no longer exists.
 *
 * `Fact.destroyCascade` used to delete only the fact row, so every fact
 * deletion before 2026-08-03 left its topics behind — active, still fetching
 * feed content for the deleted interest, and swallowing every suggestion they
 * matched (Dashboard ownership resolution drops rows whose winning fact is
 * missing). The cascade is fixed, but devices that already deleted facts hold
 * the orphans forever; this sweep is their one path back to a working
 * Dashboard. Location topics (`fact_id` null) are not orphans and are skipped.
 */
export async function destroyOrphanedTopics(validFactIds: Set<string>): Promise<number> {
  const owned = await topicsCollection
    .query(Q.where('fact_id', Q.notEq(null)))
    .fetch();
  const orphans = owned.filter((t) => t.factId && !validFactIds.has(t.factId));
  if (orphans.length === 0) return 0;
  await database.write(async () => {
    await database.batch(orphans.map((t) => t.prepareDestroyPermanently()));
  });
  return orphans.length;
}

/**
 * Wave 11 — mint `topics` rows for the texts an LLM topic-generation run produced
 * for a fact. This is the gap-fix: live fact-saves used to land topics only in
 * `fact.metadata.topics`, so they never reached the wave-7 feed retrieval (which
 * reads the `topics` TABLE). Deduped per fact against the fact's existing rows by
 * normalized text (so re-generation / "generate more" never duplicates). Rows are
 * `active`, provenance `llm`, seed weight from config, not high-priority.
 *
 * NOTE: intentionally does NOT append a persona_change_log row. Bulk LLM minting
 * is not a user mutation (mirrors the migration precedent, which logged only
 * because it seeded a brand-new persona). User-facing topic edits DO log — those
 * route through mutation-rails / persona-action-executor.
 */
export async function syncLlmTopicsForFact(
  factId: string,
  topicTexts: string[],
): Promise<TopicModel[]> {
  if (topicTexts.length === 0) return [];
  const existing = await getByFact(factId);
  const planned = planLlmTopicRows(
    existing.map((t) => t.normalizedText),
    topicTexts,
    normalizeTopicText,
  );
  if (planned.length === 0) return [];
  return createTopics(
    planned.map((p) => ({
      factId,
      text: p.text,
      normalizedText: p.normalizedText,
      weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight,
      status: 'active' as const,
      provenance: 'llm' as const,
      highPriority: false,
    })),
  );
}

/**
 * Re-parent every topic row owned by `fromFactId` onto `toFactId`. Used by the
 * conflict-resolution "merge" flow (the old fact is deleted; its topics follow
 * the surviving fact). Single write. NOT invertible — no change-log row is
 * appended (there is no reassign_topic inverse yet).
 */
export async function reassignTopics(
  fromFactId: string,
  toFactId: string,
): Promise<number> {
  const rows = await getByFact(fromFactId);
  if (rows.length === 0) return 0;
  await database.write(async () => {
    const now = new Date();
    const batch = rows.map((r) =>
      r.prepareUpdate((t) => {
        t.factId = toFactId;
        t.updatedAt = now;
      }),
    );
    await database.batch(batch);
  });
  return rows.length;
}
