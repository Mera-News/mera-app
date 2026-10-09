// Shared kit for the fact-check seam tests. Not a test file (Jest matches *.test.ts only).
//
// The server path is driven through the real Apollo client and the in-memory DB; the only thing a
// test scripts is what the two server operations answer. `serveChecks` also records WHICH
// operation each call used, so "every re-read goes through cachedFactCheck" and "the billed query
// only from an explicit ask" are assertions on the wire, not on a mock.
import { listFactChecksForArticle } from '@/lib/database/services/fact-check-record-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { getSavedSuggestionWithKind } from '@/lib/database/services/saved-article-suggestion-service';
import type { FactCheckRow } from '@/lib/fact-check/fact-check-types';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { toastManager } from '@/lib/toast-manager';
import { fixture, mockGateway, mockGql, server, type GatewayCall, type GatewayReply } from '@/test/helpers';

export const ASKED_KEY = 'mera_fact_check_asked_v1';

/** The BILLED operation (starts a job on a miss) and the read-only one. */
export const ASK_OP = 'GetFactCheck';
export const REREAD_OP = 'GetCachedFactCheck';

/** A server row. Complete by default; pass `status` for an in-flight one. */
export function checkRow(over: Partial<FactCheckRow> = {}): FactCheckRow {
  return { ...fixture('factCheck'), ...over } as unknown as FactCheckRow;
}
export const pendingRow = (over: Partial<FactCheckRow> = {}): FactCheckRow =>
  checkRow({
    status: 'pending',
    verdict: null,
    summary: null,
    citations: [],
    claims: [],
    completedAt: null,
    ...over,
  });

type Answer = FactCheckRow | null;
export interface ServedOp {
  op: typeof ASK_OP | typeof REREAD_OP;
  articleId: string;
}

/** Scripts the two operations. A responder gets the article id and the 1-based number of that
 *  operation's call for the article, and answers a row, null (a miss) or throws. Returns the
 *  wire log, oldest first. */
export function serveChecks(spec: {
  ask?: (articleId: string, n: number) => Answer;
  reread?: (articleId: string, n: number) => Answer;
}): ServedOp[] {
  const log: ServedOp[] = [];
  const count = (op: ServedOp['op'], id: string) => log.filter((e) => e.op === op && e.articleId === id).length;
  server.use(
    mockGql(ASK_OP, (v) => {
      const articleId = String(v.articleId);
      log.push({ op: ASK_OP, articleId });
      return { factCheck: (spec.ask ?? (() => null))(articleId, count(ASK_OP, articleId)) };
    }),
    mockGql(REREAD_OP, (v) => {
      const articleId = String(v.articleId);
      log.push({ op: REREAD_OP, articleId });
      return { cachedFactCheck: (spec.reread ?? (() => null))(articleId, count(REREAD_OP, articleId)) };
    }),
  );
  return log;
}

export const opsOf = (log: ServedOp[], op: ServedOp['op']): string[] =>
  log.filter((e) => e.op === op).map((e) => e.articleId);

/** The local rows for an article, through the app's own read. */
export const storedFor = (articleId: string) => listFactChecksForArticle(articleId);

/** The persisted asked map (setting `mera_fact_check_asked_v1`), keyed by article id. */
export async function askedMap(): Promise<Record<string, { articleId: string; suggestionId: string | null; title: string | null; askedAt: number }>> {
  const raw = await getSetting(ASKED_KEY);
  return raw ? JSON.parse(raw) : {};
}
export const askedIds = async (): Promise<string[]> => Object.keys(await askedMap());

/** Spies on the one call that announces a settled check. ESCALATION: the real manager persists the
 *  inbox row through a dynamic `import()`, which Jest cannot run without
 *  --experimental-vm-modules (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG), so the real
 *  `fact_check_done` row is unobservable here. The options handed to the manager ARE the row and the
 *  toast; everything up to that call (asked list, store, settle detection) is real. */
export function spyNotified(): jest.SpyInstance {
  return jest.spyOn(toastManager, 'showNotifiedToast').mockResolvedValue(undefined);
}

/** The options of every announcement made so far. */
export const announced = (spy: jest.SpyInstance) => spy.mock.calls.map((c) => c[0] as {
  type: string;
  source: string;
  title: string;
  body: string;
  icon: string;
  context: Record<string, any>;
  actions: { id: string; labelKey: string }[];
});

/** Waits (real timers) for a read to satisfy a predicate: fire-and-forget writes land. */
export async function settled<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  let v = await read();
  for (let t = 0; t < ms && !ok(v); t += 10) {
    await new Promise((r) => setTimeout(r, 10));
    v = await read();
  }
  return v;
}

/** One real event-loop turn (setImmediate stays real under the fake clocks). */
export const realTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Under a fake clock: advance `ms`, then let the network answer. Waits (real turns) until `ready()`
 *  holds, up to `turns` turns. */
export async function advanceAnd(ms: number, ready: () => boolean = () => true, turns = 400): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < turns && !ready(); i++) await realTurn();
}

/** The retention row for an article, or null: what `keepArticleForFactCheck` wrote. */
export const retainedAs = (articleId: string) => getSavedSuggestionWithKind(articleId);

/** A full article snapshot, the shape the article screens pass through the tick. */
export function fullArticle(id: string, over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    _id: id,
    title: 'Full snapshot headline',
    title_en_internal_only: 'Full snapshot headline',
    description_en_internal_only: 'A full description',
    pubDate: '2026-08-01T00:00:00.000Z',
    article_url: 'https://example.com/full-snapshot',
    original_language_code: 'en',
    publicationSource: { _id: id, publication_name: 'Full Snapshot Daily', country_code: 'NLD' },
    ...over,
  } as unknown as NewsArticle;
}

/** Lets fire-and-forget writes land (the tick does not await its ask). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 5000, label = 'condition'): Promise<void> {
  for (let t = 0; t < ms; t += 10) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`until: ${label} not met within ${ms}ms`);
}

// ---- the quick path: web search and synthesis through the gateway mock -----------------------
export interface Hit {
  title: string;
  url: string;
  snippet: string;
}

/** What the search route answers for one query: hits, or a raw gateway reply (503 ...), or the
 *  per-entry verdict a batched search carries. */
export type SearchAnswer = Hit[] | GatewayReply | { code: 'search-unavailable' };

export interface QuickScript {
  /** Per query. Default: two fixed hits. */
  search?: (query: string, call: GatewayCall) => SearchAnswer;
  /** The synthesis reply. Default: a plain `supported` JSON object. */
  answer?: string | ((call: GatewayCall) => GatewayReply);
}

export const HITS: Hit[] = [
  { title: 'PolitiFact on the vaccine schedule', url: 'https://politifact.com/a', snippet: '36 doses.' },
  { title: 'FactCheck.org', url: 'https://factcheck.org/b', snippet: 'The claim overstates it.' },
];

/** `n` distinct hits, for an evidence budget test. */
export const manyHits = (n: number, prefix = 'src'): Hit[] =>
  Array.from({ length: n }, (_, i) => ({ title: `Source ${prefix}${i}`, url: `https://source.invalid/${prefix}${i}`, snippet: 's' }));

const isReply = (a: SearchAnswer): a is GatewayReply =>
  typeof a === 'string' || (typeof a === 'object' && !Array.isArray(a) && ('status' in a || 'chunks' in a));

/** Installs a responder that answers the search route and the synthesis chat call. */
export function scriptQuick(script: QuickScript = {}): void {
  server.use(
    ...mockGateway((call) => {
      if (call.route === 'web-search') {
        const answer = script.search ? script.search(call.messages[0].content, call) : HITS;
        if (isReply(answer)) return answer;
        return JSON.stringify(answer);
      }
      if (typeof script.answer === 'function') return script.answer(call);
      return script.answer ?? '{"verdict":"supported","summary":"S","citations":[1]}';
    }),
  );
}

/** Records every request to a path as it starts (raw body included). */
export function watchRequests(path: string) {
  const seen: { at: number; body: Promise<string> }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === path) seen.push({ at: Date.now(), body: request.clone().text() });
  });
  return {
    count: () => seen.length,
    times: () => seen.map((s) => s.at),
    json: async () => (await Promise.all(seen.map((s) => s.body))).map((b) => JSON.parse(b) as Record<string, any>),
  };
}
