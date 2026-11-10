// The model profiles the app ships: one (provider, provider model id) pair each, with its
// harness from lib/harnesses/mapping.json. A profile id is `<provider>/<harness folder>`.
// The routing table (gateway GET /v1/routing, or DEFAULT_TABLE below) ranks them per lane.
import type { E2EEProvider } from '../e2ee/provider';
import { harnessFolderFor, loadHarness } from '../harnesses';
import type { HarnessParams } from '../harnesses/types';
import type { Lane } from './router/lanes';

export type Provider = E2EEProvider;

export type ProfileId = 'near/qwen3.8-27b' | 'near/qwen3.6-35b-a3b' | 'redpill/qwen3.8-27b';

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
};

export const isProfileId = (id: string): id is ProfileId => id in PROFILES;

const CHAT_RANKING: ProfileId[] = ['near/qwen3.8-27b', 'near/qwen3.6-35b-a3b', 'redpill/qwen3.8-27b'];
const BULK_RANKING: ProfileId[] = ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b', 'redpill/qwen3.8-27b'];

/** The gateway's seed ranking, used whenever /v1/routing has not answered. */
export const DEFAULT_TABLE: Record<Lane, ProfileId[]> = {
  'chat-tools': CHAT_RANKING,
  'chat-single': CHAT_RANKING,
  'fact-check': CHAT_RANKING,
  scoring: BULK_RANKING,
  topics: BULK_RANKING,
  background: BULK_RANKING,
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
};

/** First-token deadline for `lane` on `profile`; a buffered call's whole answer counts as its first token. */
export function firstTokenDeadlineMs(profile: Profile, lane: Lane): number {
  return profile.params.firstTokenDeadlineMs[lane] ?? 120_000;
}
