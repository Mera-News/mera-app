// ux2 B1 (owner): the Feed has no "New stories" pill. Arrivals are inserted
// live, below the pinned prefix (never above the reader), so there is nothing
// for a pill to point at. FeedScreen has no render harness, so this guards the
// source: the pill modules are gone and the screen neither mounts nor tracks it.
import fs from 'fs';
import path from 'path';

const FEED = path.join(__dirname, '..');

it('the pill component and its press helper no longer exist', () => {
    expect(fs.existsSync(path.join(FEED, 'NewStoriesPill.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(FEED, 'new-stories-pill.ts'))).toBe(false);
});

it('FeedScreen neither mounts the pill nor tracks arrivals for it', () => {
    const src = fs.readFileSync(path.join(FEED, 'FeedScreen.tsx'), 'utf8');
    for (const gone of ['NewStoriesPill', 'pressNewStoriesPill', 'awayArrivals', 'AwayArrivals', 'onScrollToIndexFailed']) {
        expect(src.includes(gone)).toBe(false);
    }
});
