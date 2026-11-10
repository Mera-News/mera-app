// Resolves a harness's prompt slots to today's prompt modules. The bases reference the modules
// the prompts already live in (nothing moved, so the Qwen text stays byte for byte); this table
// is the one place those references become imports. Kept apart from index.ts so the router can
// read params without loading every prompt module.
import { buildRouterPrompt, factRemovedPrompt } from '@/lib/mera-harness';
import {
  buildPersonaUpdateStaticPrompt,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  COMBO_PASS_TOPIC_SYSTEM_PROMPT,
  TOPIC_SANITY_SYSTEM_PROMPT,
} from '@/lib/news-harness/prompts/persona-prompts';
import {
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
} from '@/lib/news-harness/prompts/prompts';
import { IDENTITY_LINE } from '@/lib/news-harness/on-device/shared';
import { buildPersonaChatPrompt } from '@/lib/news-harness/on-device/persona-chat/prompt';
import { buildArticleFeedbackPrompt } from '@/lib/news-harness/on-device/article-feedback/prompt';
import { buildFollowStoryPrompt } from '@/lib/news-harness/on-device/follow-story/prompt';
import { buildTutorialHelpOnDevicePrompt } from '@/lib/news-harness/on-device/tutorial-help/prompt';
import { buildTopicGenPrompt } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { buildOnDeviceStoryScopePrompt } from '@/lib/news-harness/on-device/story-scope/prompt';
import { buildNotePrompt } from '@/lib/news-harness/on-device/notes/prompt';
import { buildSubscriptionReadPrompt } from '@/lib/news-harness/on-device/subscription-read/prompt';
import { loadHarness } from './index';

/** `<module path>#<export>` -> the export itself. */
export const SLOT_SOURCES: Record<string, unknown> = {
  'lib/mera-harness#buildRouterPrompt': buildRouterPrompt,
  'lib/mera-harness#factRemovedPrompt': factRemovedPrompt,
  'lib/news-harness/prompts/persona-prompts#buildPersonaUpdateStaticPrompt': buildPersonaUpdateStaticPrompt,
  'lib/news-harness/prompts/persona-prompts#CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT': CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  'lib/news-harness/prompts/persona-prompts#COMBO_PASS_TOPIC_SYSTEM_PROMPT': COMBO_PASS_TOPIC_SYSTEM_PROMPT,
  'lib/news-harness/prompts/persona-prompts#TOPIC_SANITY_SYSTEM_PROMPT': TOPIC_SANITY_SYSTEM_PROMPT,
  'lib/news-harness/prompts/prompts#CLOUD_RELEVANCE_SYSTEM_PROMPT': CLOUD_RELEVANCE_SYSTEM_PROMPT,
  'lib/news-harness/prompts/prompts#CLOUD_REASON_SYSTEM_PROMPT': CLOUD_REASON_SYSTEM_PROMPT,
  'lib/news-harness/prompts/prompts#CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT': CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  'lib/news-harness/prompts/prompts#CLOUD_HEADLINE_REASON_SYSTEM_PROMPT': CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  'lib/news-harness/on-device/shared#IDENTITY_LINE': IDENTITY_LINE,
  'lib/news-harness/on-device/persona-chat/prompt#buildPersonaChatPrompt': buildPersonaChatPrompt,
  'lib/news-harness/on-device/article-feedback/prompt#buildArticleFeedbackPrompt': buildArticleFeedbackPrompt,
  'lib/news-harness/on-device/follow-story/prompt#buildFollowStoryPrompt': buildFollowStoryPrompt,
  'lib/news-harness/on-device/tutorial-help/prompt#buildTutorialHelpOnDevicePrompt': buildTutorialHelpOnDevicePrompt,
  'lib/news-harness/on-device/topic-gen/prompt#buildTopicGenPrompt': buildTopicGenPrompt,
  'lib/news-harness/on-device/story-scope/prompt#buildOnDeviceStoryScopePrompt': buildOnDeviceStoryScopePrompt,
  'lib/news-harness/on-device/notes/prompt#buildNotePrompt': buildNotePrompt,
  'lib/news-harness/on-device/subscription-read/prompt#buildSubscriptionReadPrompt': buildSubscriptionReadPrompt,
};

/** Every slot of the harness in `folder`, resolved. Throws on a reference the table does not hold. */
export function resolveSlots(folder: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [slot, ref] of Object.entries(loadHarness(folder).slots)) {
    if (!(ref in SLOT_SOURCES)) throw new Error(`harness "${folder}" slot "${slot}": no source "${ref}"`);
    out[slot] = SLOT_SOURCES[ref];
  }
  return out;
}
