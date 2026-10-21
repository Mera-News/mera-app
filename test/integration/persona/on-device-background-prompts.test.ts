// The on-device background prompts (lib/news-harness/on-device/{topic-gen,story-scope,notes,
// subscription-read}) as the phone's small models receive them. A small model copies a prompt's
// worked example into its answer (Apple Intelligence printed the follow-story example's options on
// the first device run), so no on-device prompt may carry a real-world entity; Gemini Nano wants a
// system instruction under ~150 words and takes about 4000 tokens of input.
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { buildNotePrompt, NOTE_CONTEXT_MAX_TOKENS } from '@/lib/news-harness/on-device/notes/prompt';
import { countTokens } from '@/lib/news-harness/on-device/shared';
import { buildOnDeviceStoryScopePrompt } from '@/lib/news-harness/on-device/story-scope/prompt';
import { buildSubscriptionReadPrompt } from '@/lib/news-harness/on-device/subscription-read/prompt';
import { buildTopicGenPrompt } from '@/lib/news-harness/on-device/topic-gen/prompt';
import { CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT, RULE_NAME_BAN } from '@/lib/news-harness/prompts/prompts';
import { STORY_SCOPE_SYSTEM_PROMPT } from '@/lib/news-harness/story-scope';

/** Places, organisations, events and labels the old prompts taught with. Case-sensitive, whole words. */
const DENYLIST = [
  'Nieuw-West', 'Amsterdam', 'Jordaan', 'Centrumeiland', 'Netherlands', 'Dutch', 'North Holland', 'Randstad',
  'Bengaluru', 'Karnataka', 'Mumbai', 'Delhi', 'Bhopal', 'Chhindwara', 'Assam', 'India', 'Indian', 'China',
  'Lisbon', 'Portugal', 'Porto', 'Madeira', 'Brazil', 'Bulgaria', 'Bulgarian', 'Sweden', 'South Africa',
  'Russia', 'Ukraine', 'Hungarian', 'Brixton', 'Times of India',
  'DeepMind', 'OpenAI', 'Google', 'ASML',
  'EU', 'Europe', 'Asia', 'Africa', 'Schengen', 'ASEAN', 'GCC', 'NRI', 'OCI', 'PIO', 'H-1B',
  'Formula 1', 'F1', 'cricket', 'Grand Prix',
];

function entitiesIn(text: string): string[] {
  return DENYLIST.filter((e) => new RegExp(`(^|[^A-Za-z])${e.replace(/[-]/g, '\\-')}([^A-Za-z]|$)`).test(text));
}

const NOW = Date.UTC(2026, 9, 20);
const NOTE_INPUT = {
  userContext: '[User facts] Works as a nurse.',
  articleTitle: 'Hospital staffing rules change',
  articleDescription: 'New staffing ratios take effect next month.',
  relevance: 0.7,
  relatedFacts: ['Works as a nurse'],
};

/** Every on-device background prompt, built with neutral inputs. */
const FLOWS: [string, { system: string; prompt: string }][] = [
  ['topic-gen', buildTopicGenPrompt({ factStatement: 'Works as a nurse', excludeTopics: ['Nurse pay'] }, 10)],
  ['story-scope', buildOnDeviceStoryScopePrompt(['Hospital staffing rules change'], NOW)],
  ['notes', buildNotePrompt(NOTE_INPUT)],
  [
    'subscription-read',
    buildSubscriptionReadPrompt({
      anchorTitle: 'Hospital staffing rules change',
      publicationName: 'The Daily Example',
      title: 'Nurses react to staffing ratios',
      description: 'Unions welcome the change.',
      category: 'health',
      eventType: null,
    }),
  ],
];

describe('on-device background prompts', () => {
  it('the entity scanner flags the prompts it replaces', () => {
    // Proves the scan below can fail: the cloud prompts still teach with these entities.
    expect(entitiesIn(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT)).toEqual(expect.arrayContaining(['Amsterdam', 'Bengaluru', 'DeepMind']));
    expect(entitiesIn(STORY_SCOPE_SYSTEM_PROMPT)).toEqual(expect.arrayContaining(['Russia', 'Ukraine']));
    expect(entitiesIn(RULE_NAME_BAN)).toEqual(['Bulgarian']);
  });

  it.each(FLOWS)('%s carries no real-world example entity', (_flow, { system, prompt }) => {
    expect(entitiesIn(system)).toEqual([]);
    expect(entitiesIn(prompt)).toEqual([]);
  });

  it.each(FLOWS)('%s keeps its system instruction under 150 words', (_flow, { system }) => {
    expect(system.split(/\s+/).filter(Boolean).length).toBeLessThan(150);
  });

  const replyTokens = DEFAULT_HARNESS_CONFIG.articlePipeline.reasonMaxTokens;
  const longNote = (facts: string[]) =>
    buildNotePrompt({
      ...NOTE_INPUT,
      userContext: `[User facts] ${facts.join('. ')}.`,
      articleTitle: 'x'.repeat(2000),
      articleDescription: 'y'.repeat(2000),
    });

  it('notes: a long fact bank is cut at a whole fact, so the input fits under 4000 tokens minus the reply', () => {
    const { system, prompt } = longNote(Array.from({ length: 600 }, (_, i) => `Fact number ${i} about the reader`));

    expect(countTokens(system) + countTokens(prompt)).toBeLessThan(4000 - replyTokens);
    const context = prompt.slice(0, prompt.indexOf('\n'));
    expect(countTokens(context)).toBeLessThanOrEqual(countTokens('User Context: ') + NOTE_CONTEXT_MAX_TOKENS);
    expect(context).toMatch(/about the reader\.$/);
    // A short bank is left alone.
    expect(buildNotePrompt(NOTE_INPUT).prompt.startsWith('User Context: [User facts] Works as a nurse.\n')).toBe(true);
  });

  it('notes: a fact bank in another script is cut by its token cost, not its length', () => {
    // A character outside ASCII costs about a token on the built-in models' tokenizers.
    const { system, prompt } = longNote(Array.from({ length: 600 }, (_, i) => `तथ्य ${i} पाठक के बारे में`));

    expect(countTokens(system) + countTokens(prompt)).toBeLessThan(4000 - replyTokens);
    expect(prompt.slice(0, prompt.indexOf('\n'))).toMatch(/बारे में\.$/);
  });
});
