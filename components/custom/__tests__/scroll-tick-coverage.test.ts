// Every scrolling list that renders translatable text must send scroll ticks.
//
// TranslatableDynamic only asks for a translation once its node measures as on
// screen, and it re-measures on `notifyScrollTick` (lib/visibility-tick). A
// list with no tick translates what is on screen at mount and nothing below
// it: rows scrolled into view stay in English (the story timeline did exactly
// that). This reads the SOURCE, because no render test sees a scroll that
// never happens.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

/** A raw scrolling list (the Smooth* wrappers tick on their own). */
const LIST = /<(FlatList|ScrollView|SectionList|FlashList|Animated\.FlatList|Animated\.ScrollView)\b/;
/** Renders text that TranslatableDynamic translates, directly or via a card. */
const TRANSLATABLE =
  /TranslatableDynamic'|ArticleCardBase|ArticleCompactCardBase|ArticleStandalone|ArticleSuggestion(Compact)?Card|ArticleContextCard|FactCheckCard|FactCheckPanel|ReasonNote|FactAccordion|ProposalCard|NegativeTopicRow|SuppressionRow|TopicPlanCard|ChatTopicsCard|NextSectionFooter/;

/** Lists that need no tick of their own, and why. */
const EXEMPT: Record<string, string> = {
  // Horizontal: visibility is measured on y only, so every chip already counts
  // as on screen.
  'for-you/BreakingStrip.tsx': 'horizontal strip',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('scroll-tick coverage', () => {
  const files = walk(ROOT)
    .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }))
    .filter(({ src }) => LIST.test(src) && TRANSLATABLE.test(src));

  it('finds the lists it is meant to guard (the discovery is not vacuous)', () => {
    expect(files.map((f) => f.rel)).toEqual(
      expect.arrayContaining(['tracked-stories/StoryTimelineScreen.tsx', 'feed/FeedScreen.tsx']),
    );
  });

  it.each(
    walk(ROOT)
      .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }))
      .filter(({ rel, src }) => LIST.test(src) && TRANSLATABLE.test(src) && !EXEMPT[rel])
      .map(({ rel }) => [rel]),
  )('%s sends scroll ticks', (rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(src).toMatch(/notifyScrollTick/);
  });
});
