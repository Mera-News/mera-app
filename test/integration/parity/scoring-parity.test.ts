// Before/after golden for the feed: one fixed profile and one fixed set of articles go through the
// real feed sync and the real scoring pipeline, and what comes out (what was sent to the model, the
// stored scores and reasons, the order of the Feed) must equal the snapshot beside this file.
// The model is the gateway mock with a responder that derives every score and reason from the
// exact text it was sent, so a changed prompt, a changed persona context or a different article
// text moves the outputs. Capture: PARITY_OUT=<file> writes the result and passes.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { createHash } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import database from '@/lib/database';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { buildFeedList } from '@/lib/stores/feed-list-selector';
import { advanceUntilDone, defaultResponder, gatewayCalls, mockGateway, server, type GatewayCall } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  PIPELINE_NOW,
  resetFeedSyncMemory,
  resetScoringWorld,
  seedInterest,
  seedLocation,
  seedTracked,
  serveHydrate,
  servePersona,
  tick,
  tickUntilScored,
} from '../data/feed-sync/steps/support';
import { settleMachine, startMachine } from '../data/feed-sync/machine/support';

jest.setTimeout(120_000);

const SNAPSHOT = path.join(__dirname, 'scoring-parity.snapshot.json');
// Each call fences its articles with a fresh random nonce; batches are formed concurrently, so
// which articles share a call can vary. Everything below is keyed on one article's own block.
const BLOCK = /<<ARTICLE ([a-f0-9]{12})>>([\s\S]*?)<<\/ARTICLE \1>>/g;
const blocks = (user: string) => [...user.matchAll(BLOCK)].map((m) => m[2]);
const context = (user: string) => user.replace(BLOCK, '<<ARTICLE>>').replace(/\b\d+ numbers\b/, 'N numbers');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Eight articles with their own words, so each one scores and reads differently. */
const ARTICLES: Record<string, { title: string; description: string; country: string | null }> = {
  f1a: { title: 'Verstappen takes pole in Abu Dhabi', description: 'Red Bull locks out the front row before the season finale.', country: 'AE' },
  f1b: { title: 'Formula 1 confirms 2027 calendar', description: 'Twenty-four races, with Madrid joining and Imola dropped.', country: null },
  msp: { title: 'MotoGP rider fined after Valencia crash', description: 'Stewards hand down a grid penalty for the next race.', country: 'ES' },
  nhs: { title: 'Dutch hospitals short of night nurses', description: 'Unions warn of burnout as winter admissions climb.', country: 'NL' },
  utr: { title: 'Rail strike halts trains across Utrecht', description: 'NS cancelled most services during the 24-hour walkout.', country: 'NL' },
  utc: { title: 'Utrecht council approves new cycle bridge', description: 'The bridge links Leidsche Rijn with the city centre.', country: 'NL' },
  gld: { title: 'Gold hits record as markets slide', description: 'Investors move to safe assets after weak jobs data.', country: 'US' },
  ten: { title: 'Wimbledon raises prize money again', description: 'Singles champions will receive three million pounds.', country: 'GB' },
};

/** Score = a fixed function of the system prompt and the article's own fenced block. */
function score(system: string, block: string): number {
  return Math.round((0.05 + (parseInt(sha(system + '\n' + block).slice(0, 4), 16) % 91) / 100) * 100) / 100;
}

function responder(call: GatewayCall) {
  const system = call.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
  if (call.callId?.startsWith('score:')) {
    return JSON.stringify(blocks(user).map((b) => score(system, b)));
  }
  if (call.callId?.startsWith('reason:')) {
    // The v3 note prompt asks for a keep verdict as JSON; the older reason prompt for prose.
    // The note must be grounded in the article and the fact, or the app drops it; the hash ties it
    // to the exact prompt it answered.
    const block = blocks(user).join('\n');
    const title = /News Title: (.*)/.exec(block)?.[1]?.trim() ?? '';
    const fact = /Related User Fact: (.*)/.exec(block)?.[1]?.trim() ?? '';
    const why = `${title}, which ties to ${fact} (${sha(system + '\n' + context(user) + block).slice(0, 8)}).`;
    return system.includes('"keep"') ? JSON.stringify({ keep: true, why }) : why;
  }
  return defaultResponder(call);
}

async function seedProfile() {
  await seedInterest('I follow Formula 1', ['formula 1', 'motorsport']);
  await seedInterest('Works as a nurse in Utrecht', ['dutch healthcare', 'utrecht news']);
  await seedLocation('NL', 1, 'home');
  await seedTracked('Utrecht rail strike');
}

function serveArticles() {
  const served = serveHydrate({
    article: (id) => {
      const a = ARTICLES[id];
      return art(id, { title: a.title, title_en: a.title, description_en: a.description, country_code: a.country });
    },
  });
  server.use(
    servePersona({
      topics: {
        'formula 1': ['f1a', 'f1b'],
        motorsport: ['msp', 'f1a'],
        'dutch healthcare': ['nhs'],
        'utrecht news': ['utc', 'utr'],
        'utrecht rail strike': ['utr'],
      },
      headlines: [
        { scope: 'GLOBAL', ids: ['gld', 'ten'] },
        { scope: 'COUNTRY', countryCode: 'NL', ids: ['nhs', 'utr'] },
      ],
    }),
    ...served.handlers,
    ...mockGateway(responder),
  );
}

/** Ticks the pipeline until no row still owes its note and the model saw nothing new for three ticks. */
async function tickUntilQuiet(): Promise<void> {
  let quiet = 0;
  let seen = gatewayCalls().length;
  for (let i = 0; i < 300 && quiet < 3; i += 1) {
    await tick();
    const now = gatewayCalls().length;
    const owed = (await loadSuggestions()).some((s: any) => s.status === 'reason_pending');
    quiet = now === seen && !owed && (await getPipeline()) === null ? quiet + 1 : 0;
    seen = now;
  }
}

/** Local row ids are random per run: every fact or topic id anywhere in the result becomes its text. */
function relabel(value: unknown, label: Map<string, string>): unknown {
  if (typeof value === 'string') return label.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => relabel(v, label));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relabel(v, label)]));
  }
  return value;
}

async function capture() {
  const label = new Map<string, string>();
  for (const f of await database.get('facts').query().fetch()) label.set(f.id, `fact:${(f as any).statement}`);
  for (const t of await database.get('topics').query().fetch()) label.set(t.id, `topic:${(t as any).text}`);
  // One entry per article a call carried: the call kind, its system prompt, the article's own block
  // and the rest of the user message. Sorted, so batch order and composition do not matter.
  const calls = gatewayCalls()
    .flatMap((c) => {
      const system = sha(c.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'));
      const user = c.messages.filter((m) => m.role !== 'system').map((m) => `${m.role}:${m.content}`).join('\n');
      const kind = `${c.route}:${(c.callId ?? '').split(':')[0]}`;
      const own = blocks(user);
      return (own.length ? own : ['']).map((b) => ({ kind, model: c.model, system, article: sha(b), context: sha(context(user)) }));
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // Read back through the app's own service: the store is refreshed only when the sync ends,
  // before the reasons land. Local row ids are relabelled below.
  const suggestions = await loadSuggestions();
  const rows = [...suggestions]
    .sort((a, b) => a._id.localeCompare(b._id))
    .map((s: any) => ({ ...s, factIds: [...(s.factIds ?? [])].sort() }));
  const feed = buildFeedList(suggestions, new Set(), PIPELINE_NOW + 60 * 60 * 1000).map((item) => JSON.parse(JSON.stringify(item)));
  const picks = feed.map((item: any) => item.s?._id ?? item.id ?? null);
  return relabel({ calls, rows, picks, feed }, label) as Record<string, unknown>;
}

describe('scoring parity: one profile, one set of articles', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  it('sends, scores, explains and orders exactly as the snapshot', async () => {
    await seedProfile();
    serveArticles();

    await advanceUntilDone(startMachine());
    await advanceUntilDone(tickUntilScored(Object.keys(ARTICLES).length));
    await tickUntilQuiet();

    const result = await capture();
    if (process.env.PARITY_OUT) {
      fs.writeFileSync(process.env.PARITY_OUT, JSON.stringify(result, null, 2) + '\n');
      return;
    }
    expect(result).toEqual(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')));
  });
});
