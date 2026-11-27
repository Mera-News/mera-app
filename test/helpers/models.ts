// The model ids at the head of each lane, for tests that assert what reached the gateway.
import { CHAT_MODELS, PROFILES, SCORING_MODELS } from '@/lib/llm/profiles';

export const CHAT_HEAD = PROFILES[CHAT_MODELS[0]].model;
export const SCORING_HEAD = PROFILES[SCORING_MODELS[0]].model;
