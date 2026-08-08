// Every i18n key the tutorials module reads is DERIVED here from ids in the
// registry. Nothing in the module hand-writes a chapter/slide key.
//
// Why it matters: a translator dropping a key, or an author renaming a slide,
// must fail a test rather than silently render `tutorials.chapters.feed.slides.
// fe4.headline` to a user. `__tests__/chapters.test.ts` walks the registry
// through these functions and asserts every result resolves in
// `lib/locales/en.json`, so the derivation and the assertion can never disagree.

import type {
  ChapterId,
  TutorialChapter,
  TutorialSlide,
} from './types';

/** Root of the tutorials namespace in every locale file. */
export const TUTORIALS_NS = 'tutorials';

const chapterRoot = (chapter: ChapterId): string =>
  `${TUTORIALS_NS}.chapters.${chapter}`;

const slideRoot = (chapter: ChapterId, slideId: string): string =>
  `${chapterRoot(chapter)}.slides.${slideId}`;

export const chapterTitleKey = (chapter: ChapterId): string =>
  `${chapterRoot(chapter)}.title`;

export const chapterSubtitleKey = (chapter: ChapterId): string =>
  `${chapterRoot(chapter)}.subtitle`;

export const slideHeadlineKey = (chapter: ChapterId, slideId: string): string =>
  `${slideRoot(chapter, slideId)}.headline`;

export const slideBodyKey = (chapter: ChapterId, slideId: string): string =>
  `${slideRoot(chapter, slideId)}.body`;

/** The message pre-filled into the Ask-Mera chat from this slide. */
export const slideAskKey = (chapter: ChapterId, slideId: string): string =>
  `${slideRoot(chapter, slideId)}.ask`;

/** `steps` placeholder row label, 0-indexed. */
export const stepKey = (chapter: ChapterId, slideId: string, index: number): string =>
  `${slideRoot(chapter, slideId)}.steps.${index}`;

/** `tap-to-reveal` — the always-visible chip label… */
export const revealLabelKey = (
  chapter: ChapterId,
  slideId: string,
  targetId: string,
): string => `${slideRoot(chapter, slideId)}.reveal.${targetId}.label`;

/** …and the sentence a tap uncovers. */
export const revealTextKey = (
  chapter: ChapterId,
  slideId: string,
  targetId: string,
): string => `${slideRoot(chapter, slideId)}.reveal.${targetId}.text`;

/** `choose` — the option's own label… */
export const chooseLabelKey = (
  chapter: ChapterId,
  slideId: string,
  optionId: string,
): string => `${slideRoot(chapter, slideId)}.choose.${optionId}.label`;

/** …and the one-line response shown after it is picked. */
export const chooseFeedbackKey = (
  chapter: ChapterId,
  slideId: string,
  optionId: string,
): string => `${slideRoot(chapter, slideId)}.choose.${optionId}.feedback`;

export const sortCardKey = (
  chapter: ChapterId,
  slideId: string,
  cardId: string,
): string => `${slideRoot(chapter, slideId)}.sort.cards.${cardId}`;

export const sortBucketKey = (
  chapter: ChapterId,
  slideId: string,
  bucketId: string,
): string => `${slideRoot(chapter, slideId)}.sort.buckets.${bucketId}`;

export const beforeAfterKey = (
  chapter: ChapterId,
  slideId: string,
  side: 'before' | 'after',
): string => `${slideRoot(chapter, slideId)}.beforeAfter.${side}`;

/**
 * The id an animation file would ship under (`assets/animations/<id>.json`) and
 * the key `animation-registry.ts` looks up. DERIVED so a slide rename can never
 * leave a registry entry pointing at a scene that no longer exists.
 */
export const animationIdFor = (chapter: ChapterId, slideId: string): string =>
  `${chapter}-${slideId}`;

/**
 * Every i18n key a single slide needs, in one list. The player never calls this
 * (it resolves keys lazily, per render); it exists so the registry test has one
 * exhaustive source of truth to assert against, and so adding a new interaction
 * kind without adding its keys here is impossible to do quietly — the switch
 * below is exhaustive over `Interaction['kind']`.
 */
export function keysForSlide(
  chapter: ChapterId,
  slide: TutorialSlide,
): string[] {
  const keys = [
    slideHeadlineKey(chapter, slide.id),
    slideBodyKey(chapter, slide.id),
  ];

  if (slide.hasAsk) keys.push(slideAskKey(chapter, slide.id));

  if (slide.visual.placeholder.kind === 'steps') {
    const { count } = slide.visual.placeholder;
    for (let i = 0; i < count; i += 1) keys.push(stepKey(chapter, slide.id, i));
  }

  const interaction = slide.interaction;
  if (!interaction) return keys;

  switch (interaction.kind) {
    case 'tap-to-reveal':
      for (const target of interaction.targets) {
        keys.push(revealLabelKey(chapter, slide.id, target.id));
        keys.push(revealTextKey(chapter, slide.id, target.id));
      }
      break;
    case 'choose':
      for (const option of interaction.options) {
        keys.push(chooseLabelKey(chapter, slide.id, option.id));
        keys.push(chooseFeedbackKey(chapter, slide.id, option.id));
      }
      break;
    case 'sort':
      for (const card of interaction.cards) {
        keys.push(sortCardKey(chapter, slide.id, card.id));
      }
      for (const bucket of interaction.buckets) {
        keys.push(sortBucketKey(chapter, slide.id, bucket.id));
      }
      break;
    case 'before-after':
      keys.push(beforeAfterKey(chapter, slide.id, 'before'));
      keys.push(beforeAfterKey(chapter, slide.id, 'after'));
      break;
  }

  return keys;
}

/** Chapter-level keys plus every slide's. */
export function keysForChapter(chapter: TutorialChapter): string[] {
  const keys = [chapterTitleKey(chapter.id), chapterSubtitleKey(chapter.id)];
  for (const slide of chapter.slides) {
    keys.push(...keysForSlide(chapter.id, slide));
  }
  return keys;
}

/**
 * Resolve a dotted key against a parsed locale object.
 *
 * Exists so the test can assert on the JSON itself rather than on a live i18next
 * instance — a missing key in i18next silently returns the key string back, so
 * asserting through `t()` would pass on exactly the failure the test is for.
 */
export function lookupKey(
  dictionary: unknown,
  key: string,
): string | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}
