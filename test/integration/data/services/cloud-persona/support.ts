// Shared by the cloud-calling persona service seam tests (data-U11b): hygiene, optimisation plan,
// geo derivation and the sanity backfill. Not a test file.
//
// Everything runs on the in-memory DB with the real services, real stores and the gateway mock (real
// E2EE both ways). A model call is answered by a responder keyed on the decrypted prompt, so a test
// asserts what the service SENT (`gatewayCalls()`) as well as what it did with the answer.
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
import { failSecureStore, secureStoreDump, type GatewayCall, type GatewayReply } from '@/test/helpers';

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
 * The device loses its E2EE credential: the session cookie cannot be read and the cached gateway JWT is
 * gone, so the next gateway call has no token and fails with NoCredentialError before any request.
 */
export function loseCredential(): void {
  const cookieKey = Object.keys(secureStoreDump()).find((k) => k.endsWith('_cookie'));
  if (!cookieKey) throw new Error('loseCredential: no session cookie in the secure store (sign in first)');
  failSecureStore(cookieKey, 'get');
  invalidateJwtCache();
}
