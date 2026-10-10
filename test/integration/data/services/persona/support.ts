// Shared by the persona-service seam tests (data-U11): seeding through the app's own services, row
// readers for the tables under test, key-scoped DB faults and the module-memory reset. Not a test file.
// The test/helpers import below must load at file load, never first inside a hook: it registers
// @testing-library hooks on load.
import database from '@/lib/database';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import { addFact } from '@/lib/database/services/fact-service';
import { upsertLocation } from '@/lib/database/services/location-service';
import { createTopics } from '@/lib/database/services/topic-service';
import logger from '@/lib/logger';
import { seedArticles, suggestionRows, type SeedArticle } from '@/test/integration/core/sync/seed'; // core's seeder (read-only cross-area import)
import { useStrictClock as strictClockAt } from '@/test/helpers'; // aliased: a use* name in a plain function trips rules-of-hooks
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';

export const MIN = 60_000;
export const DAY = 24 * 3_600_000;
/** Local noon, so the per-day nudge window (local midnight) is 12h behind and 12h ahead. */
export const NOON = new Date(2026, 9, 9, 12, 0, 0, 0).getTime();

/** Strict clock: time moves only when a test says so. (`use*` in a plain function trips rules-of-hooks.) */
export const freezeClock = (now: number = NOON): void => strictClockAt(now);

// ---------------------------------------------------------------------------
// Module memory
// ---------------------------------------------------------------------------

/** Module state a per-test DB reset does not touch. Call from `beforeEach`. */
export function resetPersonaMemory(): void {
  __resetSuggestionsRefreshThrottleForTests();
  useForYouStore.setState({
    suggestions: [],
    articleCount: 0,
    relevantArticleCount: 0,
    unscoredCount: 0,
    isDeviceProcessing: false,
    deviceProcessProgress: 0,
    deviceProcessedCount: 0,
    deviceTotalCount: 0,
    scoringError: null,
    lastProcessingRunFinishedAt: null,
  });
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
  useHardFilterLabelStore.getState().clear();
}

/** Wait for every queued DB write, including fire-and-forget ones. Call from `afterEach`. */
export async function settleWrites(): Promise<void> {
  // let a fire-and-forget write (setCounts) reach the queue first, so ours does not arm the queue's 1.5s warning timer
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await database.write(async () => {});
}

/** Silence the real logger and expose its capture channels (spies on the real object, R23). */
export function quietLogger() {
  const spies = (['info', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(logger, m).mockImplementation(() => {}),
  );
  const captureException = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
  const addBreadcrumb = jest.spyOn(logger, 'addBreadcrumb').mockImplementation(() => {});
  return {
    captureException,
    addBreadcrumb,
    restore: () => [...spies, captureException, addBreadcrumb].forEach((s) => s.mockRestore()),
  };
}

// ---------------------------------------------------------------------------
// Seeding, through the app's services
// ---------------------------------------------------------------------------

/** A fact with one topic per text (weight 1 unless given). */
export async function seedInterest(statement: string, topics: (string | { text: string; weight?: number })[]) {
  const fact = await addFact(statement);
  const rows = await createTopics(
    topics.map((t) => {
      const seed = typeof t === 'string' ? { text: t } : t;
      return { factId: fact.id, text: seed.text, weight: seed.weight ?? 1, provenance: 'llm' as const };
    }),
  );
  return { fact, topics: rows };
}

export async function seedPlace(
  countryCode: string,
  city: string | null,
  role: 'home' | 'work' | 'travel' = 'home',
  weight = 0.5,
) {
  return upsertLocation({ city, countryCode, role, weight });
}

export { seedArticles, suggestionRows, type SeedArticle };

export async function statuses(): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await suggestionRows()).map(([id, r]) => [id, r.status]));
}

/** Put ids into the persisted feed order so a purge has something to evict. */
export function seedFeedOrder(ids: string[]): void {
  useFeedOrderStore.setState({
    hydrated: true,
    order: [...ids],
    itemsById: Object.fromEntries(ids.map((id) => [id, { id } as never])),
  });
}

// ---------------------------------------------------------------------------
// Row readers (the tables under test)
// ---------------------------------------------------------------------------

export interface LogRow {
  id: string;
  actionType: string;
  action: Record<string, unknown>;
  source: string;
  summary: string;
  reverted: boolean;
}

const toLog = (r: PersonaChangeLogModel): LogRow => ({
  id: r.id,
  actionType: r.actionType,
  action: JSON.parse(r.actionJson),
  source: r.source,
  summary: r.summary,
  reverted: r.reverted,
});

/** Every change-log row, oldest first (stable for equal timestamps). */
export async function logRows(): Promise<LogRow[]> {
  const rows = await database.get<PersonaChangeLogModel>('persona_change_log').query().fetch();
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toLog);
}

export async function logRow(id: string): Promise<LogRow> {
  return toLog(await database.get<PersonaChangeLogModel>('persona_change_log').find(id));
}

export async function logsOf(actionType: string): Promise<LogRow[]> {
  return (await logRows()).filter((r) => r.actionType === actionType);
}

/**
 * A plain snapshot of a model: its id plus every decorated field. Models carry observable plumbing
 * (`__changes` is a BehaviorSubject that refers back to the model), so a failing matcher that tried to
 * serialise one crashed the worker instead of reporting the diff.
 */
function plain(model: any): any {
  const out: Record<string, unknown> = { id: model.id };
  for (const key in model) {
    if (Object.prototype.hasOwnProperty.call(model, key) || key.startsWith('_')) continue; // plumbing, not fields
    if (typeof model[key] !== 'function') out[key] = model[key];
  }
  return out;
}

export async function rowsOf<T = any>(table: string): Promise<T[]> {
  return (await database.get(table).query().fetch()).map(plain) as unknown as T[];
}

export async function rowById<T = any>(table: string, id: string): Promise<T> {
  return plain(await database.get(table).find(id)) as T;
}

export { failTableQuery, restoreFaults } from '../../support/faults';
