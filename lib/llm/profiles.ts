// The model profiles the app ships: one (provider, provider model id) pair each, with its
// harness from lib/harnesses/mapping.json. A profile id is `<provider>/<harness folder>`.
// The routing table (gateway GET /v1/routing, or DEFAULT_TABLE below) ranks them per lane.
import type { E2EEProvider } from '../e2ee/provider';
import { harnessFolderFor, loadHarness } from '../harnesses';
import type { HarnessParams } from '../harnesses/types';
import type { Lane } from './router/lanes';

export type Provider = E2EEProvider;

export type ProfileId =
  | 'near/qwen3.8-27b'
  | 'near/qwen3.6-35b-a3b'
  | 'redpill/qwen3.8-27b'
  | 'redpill/gemma-4-31b'
  | 'redpill/kimi-k2.6';

export interface Profile {
  id: ProfileId;
  provider: Provider;
  /** Sent as `model`, exactly as the provider names it. */
  model: string;
  /** Folder under lib/harnesses. */
  harness: string;
  params: HarnessParams;
}

function profile(provider: Provider, model: string): Profile {
  const harness = harnessFolderFor(provider, model);
  if (!harness) throw new Error(`no harness mapped for ${provider}:${model}`);
  return { id: `${provider}/${harness}` as ProfileId, provider, model, harness, params: loadHarness(harness).params };
}

export const PROFILES: Record<ProfileId, Profile> = {
  'near/qwen3.8-27b': profile('near', 'Qwen/Qwen3.8-27B'),
  'near/qwen3.6-35b-a3b': profile('near', 'Qwen/Qwen3.6-35B-A3B-FP8'),
  'redpill/qwen3.8-27b': profile('redpill', 'qwen/qwen3.8-27b'),
  'redpill/gemma-4-31b': profile('redpill', 'google/gemma-4-31b-it'),
  'redpill/kimi-k2.6': profile('redpill', 'moonshotai/kimi-k2.6'),
};

export const isProfileId = (id: string): id is ProfileId => id in PROFILES;

// Qwen first (the prompts are Qwen-tuned), then the models that reached the Qwen bar in the
// qualification matrix, each only in the lanes it reached it (Kimi missed scoring; untested on
// background). Mirrors mera-inference-gateway src/routing/profiles.ts.
const CHAT_QWEN: ProfileId[] = ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'];
const BULK_QWEN: ProfileId[] = ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b', 'redpill/qwen3.8-27b'];
const GEMMA_KIMI: ProfileId[] = ['redpill/gemma-4-31b', 'redpill/kimi-k2.6'];
const GEMMA: ProfileId[] = ['redpill/gemma-4-31b'];

/** The gateway's seed ranking, used whenever /v1/routing has not answered. */
export const DEFAULT_TABLE: Record<Lane, ProfileId[]> = {
  'chat-tools': [...CHAT_QWEN, ...GEMMA_KIMI],
  'chat-single': [...CHAT_QWEN, ...GEMMA_KIMI],
  scoring: [...BULK_QWEN, ...GEMMA],
  topics: [...BULK_QWEN, ...GEMMA_KIMI],
  background: [...BULK_QWEN, ...GEMMA],
};

/**
 * Can `profile` serve a batch (/v1/chat/completions/batch) or an async job (/v1/inference/jobs)?
 * RedPill cannot: its v2 envelope is one request each (a fresh nonce, a timestamp within 300s),
 * and a batch or a job shares one header set and runs it later.
 */
export const servesBatch = (profile: Profile): boolean => profile.provider !== 'redpill';

/** Shown on the provider card. */
export const PROVIDER_INFO: Record<Provider, { name: string; url: string }> = {
  near: { name: 'NEAR AI', url: 'https://near.ai' },
  redpill: { name: 'RedPill', url: 'https://redpill.ai' },
};

/** Shown on the provider card, per harness folder (the same model on two providers reads the same). */
export const MODEL_LABELS: Record<string, string> = {
  'qwen3.8-27b': 'Qwen3.8 27B',
  'qwen3.6-35b-a3b': 'Qwen3.6 35B',
  'gemma-4-31b': 'Gemma 4 31B',
  'kimi-k2.6': 'Kimi K2.6',
};

/** First-token deadline for `lane` on `profile`; a buffered call's whole answer counts as its first token. */
export function firstTokenDeadlineMs(profile: Profile, lane: Lane): number {
  return profile.params.firstTokenDeadlineMs[lane] ?? 120_000;
}
