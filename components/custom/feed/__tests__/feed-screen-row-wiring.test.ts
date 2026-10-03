// FeedScreen's pending-note wiring, checked in its SOURCE.
//
// FeedScreen cannot be rendered under jest at useful cost: its import graph
// constructs the WatermelonDB adapter at module load (initializeJSI), and it
// mounts reanimated, the collapsing header, the scheduler-backed status hooks
// and a dozen stores. `FeedScreen.test.tsx` tests only extracted helpers for the
// same reason. The logic lives in pure modules with their own suites
// (feed-list-selector, feed-row-display, use-reason-in-flight, the cards); this
// file pins the four lines that connect them, so deleting one goes red.

import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'FeedScreen.tsx'), 'utf8')
  // Comments say these words too; only code counts.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('FeedScreen pending-note wiring', () => {
  it('asks the list for scored rows still awaiting their note', () => {
    expect(src).toMatch(/buildFeedList\([^;]*?\{\s*includeReasonPending:\s*true,?\s*\}/);
  });

  it('renders every row through resolveFeedRowDisplay and hands its result to the row', () => {
    expect(src).toMatch(/resolveFeedRowDisplay\(item,\s*liveById,\s*rowSessionRef\.current\)/);
    expect(src).toMatch(/suggestion=\{display\.suggestion\}/);
    expect(src).toMatch(/reserveNoteSpace=\{display\.reserveNoteSpace\}/);
  });

  it('the row reads the in-flight signal for the suggestion it SHOWS and passes both props to the card', () => {
    expect(src).toMatch(/useReasonWriting\(suggestion\._id\)/);
    expect(src).toMatch(/reasonWriting=\{reasonWriting\}/);
    expect(src).toMatch(/reserveNoteSpace=\{reserveNoteSpace\}/);
    // Never the store's representative: that is the swap this exists to stop.
    expect(src).not.toMatch(/suggestion=\{item\.suggestion\}/);
  });

  it('sorts a card awaiting its note by the article it SHOWS, and re-sorts when a note lands', () => {
    expect(src).toMatch(
      /sortFeedEntries\([^;]*?\(it\) => isAwaitingNote\(displayedSuggestionOf\(it,\s*liveById,\s*rowSessionRef\.current\)\),?\s*\)/,
    );
    // `liveById` changes when a note lands; without it the row never rises.
    expect(src).toMatch(/\[data,\s*partitionSnapshot,\s*pinnedIds,\s*liveById\]/);
    // Never the store's representative, which fronts a member that has its note.
    expect(src).not.toMatch(/isAwaitingNote\(it\.suggestion\)/);
  });

  it('resetSession starts a fresh row session, and taps resolve the frozen representative first', () => {
    expect(src).toMatch(/const resetSession = useCallback\(\(\) => \{\s*rowSessionRef\.current = newFeedRowSession\(\);/);
    expect(src).toMatch(/keyFor: \(s\) => rowSessionRef\.current\.rowBySuggestion\.get\(s\._id\)/);
    expect(src).toMatch(/const key = rowSessionRef\.current\.rowBySuggestion\.get\(s\._id\)/);
  });
});
