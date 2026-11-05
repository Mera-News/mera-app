// The owner's rule in the app's own words: the profile is for what affects the
// reader, everything else is followed. A dictionary sweep, because the strings
// that break it sit on many screens and no screen test reads them all.

import en from '@/lib/locales/en.json';
import { buildTutorialHelpPrompt } from '@/lib/news-harness/tutorial-help';
import { getChapter } from '@/lib/tutorials/chapters';

const RULE = 'Your profile is for what affects you. Everything else, just follow.';

function flatten(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => flatten(v, path ? `${path}.${k}` : k));
}
const strings = flatten(en);

// On-device chat has no follow path, so its own openers keep today's meaning.
const shared = strings.filter(([key]) => !key.startsWith('meraIntro.onDevice.'));

describe('the profile rule in en.json', () => {
  it('uses the exact line where a reader goes to learn', () => {
    const facts = en.tutorials.chapters.facts;
    expect(facts.subtitle).toBe(RULE);
    expect(facts.slides['profile-or-story'].body).toBe(RULE);
    expect(en.facts.screenSubtitle).toContain(RULE);
  });

  it('never names "interests" as a place to put something', () => {
    const offenders = shared.filter(([, v]) => /\b(your|my) interests\b/i.test(v));
    expect(offenders).toEqual([]);
  });

  it('never asks what the reader follows, outside the on-device openers', () => {
    const offenders = shared.filter(([, v]) => /\bwhat you (follow|like to follow)\b/i.test(v));
    expect(offenders).toEqual([]);
  });

  it('says no AI reads followed stories, and never that no AI is involved', () => {
    expect(strings.filter(([, v]) => /no AI is involved/i.test(v))).toEqual([]);
    expect(strings.filter(([, v]) => /no AI reads followed stories/i.test(v)).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the on-device openers on their old meaning', () => {
    expect(en.meraIntro.onDevice.sources).toBe("Tell me what you follow and I'll keep it in mind for your Feed.");
  });
});

describe('the Profile or story? slide', () => {
  it('closes the facts chapter, with F1 both ways', () => {
    const slides = getChapter('facts')!.slides;
    expect(slides[slides.length - 1].id).toBe('profile-or-story');
    const reveal = en.tutorials.chapters.facts.slides['profile-or-story'].reveal;
    expect(reveal.follow.label).toBe('I like Formula 1');
    expect(reveal.profile.label).toBe("I'm going to Monaco");
  });
});

it('the cloud tutorial help knows the rule and drops the word interests', () => {
  const prompt = buildTutorialHelpPrompt();
  expect(prompt).toMatch(/no AI reads followed stories/i);
  expect(prompt).not.toMatch(/\binterests\b/i);
});
