// N16: the feed-status panel's text blended into the page. These pin the ink
// by arithmetic and by source, because a class-name assertion cannot see a
// colour (see the share card's typography-0 incident).
import fs from 'fs';
import path from 'path';
import {
  STATUS_INK,
  STATUS_PANEL_WORST_BG,
  contrastRatio,
  parseRgb,
  pickScoringProgress,
} from '../status-ink';

describe('status panel ink', () => {
  it('keeps every text colour at 4.5:1 or better over the worst modelled panel', () => {
    for (const [name, color] of Object.entries({ primary: STATUS_INK.primary, secondary: STATUS_INK.secondary })) {
      const ratio = contrastRatio(parseRgb(color), STATUS_PANEL_WORST_BG);
      expect({ name, ok: ratio >= 4.5 }).toEqual({ name, ok: true });
    }
  });

  it('THE CONTROL: the old label grey fails the same check', () => {
    expect(contrastRatio([140, 140, 140], STATUS_PANEL_WORST_BG)).toBeLessThan(4.5);
  });

  it('refuses the low-contrast tokens and the old divider in both files', () => {
    for (const file of ['FeedStatusPanel.tsx', 'FeedStatusDetails.tsx']) {
      const src = fs
        .readFileSync(path.resolve(__dirname, '..', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect({ file, hits: src.match(/typography-[0-5]00|#1f2937/g) ?? [] }).toEqual({ file, hits: [] });
    }
  });
});

describe('pickScoringProgress: one figure for one job', () => {
  it('prefers the batch article progress over the sweep counter', () => {
    // The owner screenshot showed 30 / 36 and 30 of 39 at once.
    expect(pickScoringProgress({ done: 30, total: 39 }, 30, 36)).toEqual({ done: 30, total: 39 });
  });

  it('falls back to the sweep counter when no batch total is known', () => {
    expect(pickScoringProgress(null, 4, 10)).toEqual({ done: 4, total: 10 });
    expect(pickScoringProgress({ done: 0, total: 0 }, 4, 10)).toEqual({ done: 4, total: 10 });
  });

  it('is null when nothing is running', () => {
    expect(pickScoringProgress(null, 0, 0)).toBeNull();
  });
});
