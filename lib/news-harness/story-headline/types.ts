// news-harness — story-headline types (PURE, RN-free).
//
// The story-headline pipeline names a followed ("tracked") story with ONE short
// English headline, derived from the titles of the articles that make it up.
// Everything here is data-only so the prompt builder + parser stay unit-testable
// off-device. The generated headline is stored English-canonical and rendered
// downstream via TranslatableDynamic.

/** The {system, user} pair for one story-headline generation call. */
export interface StoryHeadlinePrompt {
  system: string;
  user: string;
}
