// Shared by the cloud-calling persona service seam tests (data-U11b): hygiene, optimisation plan,
// geo derivation and the sanity backfill. Not a test file.
//
// Everything runs on the in-memory DB with the real services, real stores and the gateway mock (real
// E2EE both ways). A model call is answered by a responder keyed on the decrypted prompt, so a test
// asserts what the service SENT (`gatewayCalls()`) as well as what it did with the answer.
import * as SecureStore from 'expo-secure-store';

import { invalidateJwtCache } from '@/lib/auth-client';
import { addFact } from '@/lib/database/services/fact-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import logger from '@/lib/logger';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { toastManager } from '@/lib/toast-manager';
import { secureStoreDump, type GatewayCall, type GatewayReply } from '@/test/helpers';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The fake "now" every test starts at. */
export const T0 = Date.parse('2026-10-09T10:00:00Z');

// ---------------------------------------------------------------------------
// Module memory
// ---------------------------------------------------------------------------

const resetStore = (store: unknown): void =>
  (store as { setState(s: unknown, replace: true): void; getInitialState(): unknown }).setState(
    (store as { getInitialState(): unknown }).getInitialState(),
    true,
  );

/** The cloud call path (limiter spacing, fallback ladder, attestation and JWT caches) and the mode store. */
export function resetCloudPersonaMemory(): void {
  resetLimiter();
  resetModelFallback();
  __resetOnDeviceGateForTests();
  clearAttestationCache();
  invalidateJwtCache();
  resetStore(useMeraProtocolStore);
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
}

/** The mode the way the settings screen leaves it: the store AND the persisted row. */
export async function setMode(mode: 'cloud' | 'on-device'): Promise<void> {
  const value = mode === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice;
  useMeraProtocolStore.setState({ processingMode: value });
  await setSetting('mera_processing_mode', value);
}

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

/** Spies on the real toast manager, calls through (T-dialog): the notified toast writes its real notification row. */
export function spyOnNotifications() {
  const spy = jest.spyOn(toastManager, 'showNotifiedToast');
  return {
    /** The options each notified toast was called with. */
    calls: () => spy.mock.calls.map((c) => c[0]),
    restore: () => spy.mockRestore(),
  };
}

/** Silence the real logger and expose its capture channels (spies on the real object, R23). */
export function quietLogger() {
  const [info, warn, error, debug] = (['info', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(logger, m).mockImplementation(() => {}),
  );
  const spies = [info, warn, error, debug];
  const captureException = jest.spyOn(logger, 'captureException').mockImplementation(() => '');
  const addBreadcrumb = jest.spyOn(logger, 'addBreadcrumb').mockImplementation(() => {});
  return {
    warn,
    captureException,
    addBreadcrumb,
    restore: () => [...spies, captureException, addBreadcrumb].forEach((s) => s.mockRestore()),
  };
}

// ---------------------------------------------------------------------------
// The model side
// ---------------------------------------------------------------------------

/** The user message of a decrypted call. */
export const userMessage = (call: GatewayCall): string => call.messages.find((m) => m.role === 'user')?.content ?? '';
export const systemMessage = (call: GatewayCall): string => call.messages.find((m) => m.role === 'system')?.content ?? '';

/** `N. "text"` lines of a topic-sanity prompt, in the order the model sees them. */
export function sanityItems(call: GatewayCall): { n: number; text: string }[] {
  return [...userMessage(call).matchAll(/^(\d+)\. "(.*)"$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
}

/** Every topic text a gateway call's sanity prompts carried, across a batch of calls. */
export const sanityTexts = (calls: GatewayCall[]): string[] => calls.flatMap((c) => sanityItems(c).map((i) => i.text));

/**
 * A topic-sanity model: judges every numbered topic of the prompt, flagging the ones `isBad` names.
 * Unknown prompts get an empty array (a harmless reply), never a thrown error.
 */
export function sanityModel(isBad: (topicText: string) => boolean = (t) => /festival music tech/.test(t)) {
  return (call: GatewayCall): GatewayReply => {
    const items = sanityItems(call);
    return JSON.stringify(items.map((i) => ({ i: i.n, ok: !isBad(i.text) })));
  };
}

// ---------------------------------------------------------------------------
// Seeding, through the app's services
// ---------------------------------------------------------------------------

export interface TopicSeed {
  text: string;
  weight?: number;
  provenance?: 'llm' | 'user' | 'feedback' | 'tracked' | 'combo' | 'migration' | 'exploration';
  status?: 'active' | 'suppressed' | 'retired';
}

export async function seedTopics(factId: string | null, topics: (string | TopicSeed)[]) {
  return createTopics(
    topics.map((t) => {
      const seed = typeof t === 'string' ? { text: t } : t;
      return {
        factId,
        text: seed.text,
        weight: seed.weight ?? 0.75,
        provenance: seed.provenance ?? ('llm' as const),
        status: seed.status ?? ('active' as const),
      };
    }),
  );
}

/** A fact with topic rows. `createTopics` also appends each text to `fact.metadata.topics`. */
export async function seedFact(statement: string, topics: (string | TopicSeed)[] = []) {
  const fact = await addFact(statement);
  const rows = await seedTopics(fact.id, topics);
  return { fact, topics: rows };
}

/**
 * `count` topics on one fact, one write each, `stepMs` apart on the (fake) clock, so every row has its own
 * `created_at` (the audit cursor orders on it). Leaves the clock at the last row's time.
 */
export async function seedTopicsOverTime(
  factId: string,
  count: number,
  opts: { startMs?: number; stepMs?: number; text?: (i: number) => string } = {},
) {
  const startMs = opts.startMs ?? T0;
  const stepMs = opts.stepMs ?? 10;
  const text = opts.text ?? ((i: number) => `cricket topic ${i}`);
  const rows = [];
  for (let i = 0; i < count; i++) {
    jest.setSystemTime(startMs + i * stepMs);
    rows.push(...(await seedTopics(factId, [text(i)])));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

/**
 * The device loses its E2EE credential: the session cookie is gone from the keychain and the cached gateway
 * JWT with it, so the next gateway call has no token and fails with NoCredentialError before any request.
 * `signInFixtureAccount()` brings it back.
 */
export async function loseCredential(): Promise<void> {
  const keys = Object.keys(secureStoreDump()).filter((k) => k.endsWith('_cookie') || k.endsWith('_session_data'));
  if (keys.length === 0) throw new Error('loseCredential: no session in the secure store (sign in first)');
  for (const key of keys) await SecureStore.deleteItemAsync(key);
  invalidateJwtCache();
}

// ---------------------------------------------------------------------------
// A persona for the hygiene tests
// ---------------------------------------------------------------------------

/** Statements that are clearly different from each other (near-identical wording trips the duplicate detector). */
export const SUBJECTS = [
  'Follows Indian cricket', 'Lives in Amsterdam', 'Works in machine learning',
  'Parents reside near Bhopal', 'Attends jazz festivals', 'Cycles competitively',
  'Reads Nordic crime fiction', 'Invests in renewable energy', 'Cooks Sichuan food',
  'Volunteers at an animal shelter', 'Studies Japanese', 'Collects vinyl records',
  'Runs marathons', 'Plays chess online', 'Restores vintage cameras',
  'Brews espresso at home', 'Sails dinghies', 'Writes science fiction',
  'Teaches mathematics', 'Practises pottery', 'Watches Formula One',
  'Grows bonsai trees', 'Climbs indoor routes', 'Tracks migratory birds',
  'Repairs mechanical watches',
];

/**
 * `count` facts created `ageDays` before `T0`. Fact 0 is the single word "News" (the analyzer calls it too
 * broad); the rest read differently from one another, so a persona of them proposes exactly one cleanup.
 */
export async function seedPersona(count: number, ageDays = 100) {
  jest.setSystemTime(T0 - ageDays * DAY);
  const facts = [];
  for (let i = 0; i < count; i++) facts.push(await addFact(i === 0 ? 'News' : `distinct interest number ${i}`));
  jest.setSystemTime(T0);
  return facts;
}

/** `count` facts that each own one contaminated topic (`bad topic i`), old enough for the full sweep. */
export async function seedContaminated(count: number, ageDays = 100) {
  jest.setSystemTime(T0 - ageDays * DAY);
  const out = [];
  for (let i = 0; i < count; i++) {
    const { fact, topics } = await seedFact(SUBJECTS[i % SUBJECTS.length], [`bad topic ${i}`]);
    out.push({ fact, bad: topics[0] });
  }
  jest.setSystemTime(T0);
  return out;
}

/** Judges `bad topic N` and `festival music tech` topics incoherent, everything else fine. */
export const isContaminated = (text: string) => /^bad topic|festival music tech/.test(text);

/**
 * A fact whose topics are written one at a time, 10 ms apart in the order given, so the audit (oldest
 * first, ties broken by random id) sees them in that order. Topics from ONE `createTopics` call share a
 * millisecond, and their order in a prompt is then arbitrary.
 */
export async function seedFactOrdered(statement: string, topics: (string | TopicSeed)[], startMs = T0 - 50 * DAY) {
  const fact = await addFact(statement);
  const rows = [];
  for (let i = 0; i < topics.length; i++) {
    jest.setSystemTime(startMs + i * 10);
    rows.push(...(await seedTopics(fact.id, [topics[i]])));
  }
  jest.setSystemTime(T0);
  return { fact, topics: rows };
}
