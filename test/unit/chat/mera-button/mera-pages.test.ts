import type { SurfaceId } from '@/components/custom/nav/page-registry';
import {
  chatContextFor,
  hintKeys,
  interestFactId,
  introKeyFor,
  pageKeyFor,
  pageStarters,
} from '@/components/custom/mera-button/mera-pages';

describe('pageKeyFor', () => {
  it.each([
    ['feed', 'feed'],
    ['stories', 'stories'],
    ['world', 'world'],
    ['country:DE', 'world'],
    ['country:XK', 'world'],
    ['saved', 'library'],
    ['visited', 'library'],
    ['checks', 'checks'],
    ['profile', 'profile'],
    ['facts', 'facts'],
    ['sources', 'sources'],
    ['interest:abc123', 'interest'],
    ['locations', 'profile'],
    ['hygiene', 'profile'],
    ['activity', 'profile'],
    ['search', 'settings'],
  ])('%s -> %s', (surface, key) => {
    expect(pageKeyFor(surface as SurfaceId)).toBe(key);
  });

  it.each(['settings', 'settings:display', 'settings:mera-protocol', 'settings:notifications', 'notifications', 'unknown'])(
    'the generic set on %s (the button is always shown)',
    (surface) => {
      expect(pageKeyFor(surface as SurfaceId)).toBe('settings');
    },
  );

  it('no button before a surface is reported', () => {
    expect(pageKeyFor('' as SurfaceId)).toBeNull();
  });

  it('no button with no surface', () => {
    expect(pageKeyFor(null)).toBeNull();
  });
});

it('interestFactId reads the fact id', () => {
  expect(interestFactId('interest:f1')).toBe('f1');
  expect(interestFactId('interest:')).toBeNull();
  expect(interestFactId('feed')).toBeNull();
});

describe('hintKeys', () => {
  it('drops web-search hints while web search is off', () => {
    expect(hintKeys('feed', true)).toContain('meraHints.askNews');
    expect(hintKeys('feed', false)).not.toContain('meraHints.askNews');
  });

  it('an all-web pool empties when web search is off (no tooltip)', () => {
    expect(hintKeys('checks', true)).toHaveLength(2);
    expect(hintKeys('checks', false)).toEqual([]);
  });

  it('every pool has 2 or 3 hints with web search on', () => {
    for (const page of [
      'feed', 'interest', 'stories', 'world',
      'checks', 'library', 'facts', 'sources', 'settings',
    ] as const) {
      const n = hintKeys(page, true).length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(3);
    }
  });
});

describe('chatContextFor', () => {
  it('Stories opens the follow-story agent', () => {
    expect(chatContextFor('stories')).toEqual({ kind: 'follow-story', page: 'stories' });
  });

  it.each(['profile', 'facts', 'sources', 'interest'] as const)(
    '%s is a fact-editing chat (origin profile keeps the combination pass)',
    (page) => {
      expect(chatContextFor(page)).toMatchObject({ kind: 'persona', page, origin: 'profile' });
    },
  );

  it.each(['feed', 'world', 'checks', 'library'] as const)('%s is a plain persona chat', (page) => {
    expect(chatContextFor(page)).toEqual({ kind: 'persona', page });
  });

  it('One interest carries its fact statement', () => {
    expect(chatContextFor('interest', 'Supports Bayer Leverkusen')).toMatchObject({
      subject: 'Supports Bayer Leverkusen',
    });
  });
});

it('Checks says so when web search is off', () => {
  expect(introKeyFor('checks', true)).toBe('meraIntro.checks');
  expect(introKeyFor('checks', false)).toBe('meraIntro.checksNoWeb');
  expect(introKeyFor('stories', false)).toBe('trackedStories.followChatIntro');
});

describe('per engine', () => {
  it('web hints show only on cloud with web search on', () => {
    expect(hintKeys('feed', true, false)).toContain('meraHints.askNews');
    expect(hintKeys('feed', true, true)).not.toContain('meraHints.askNews');
    expect(hintKeys('checks', true, true)).toEqual([]);
    expect(pageStarters('library', true, undefined, true).map((s) => s.labelKey)).toEqual([
      'meraHints.library.likeToRead',
    ]);
  });

  it('fact hints stay on device', () => {
    expect(hintKeys('facts', true, true)).toEqual(hintKeys('facts', true, false));
  });

  it('on-device openers promise no lookup', () => {
    expect(introKeyFor('checks', true, true)).toBe('chat.cloudOnlyNotice');
    for (const page of ['feed', 'library', 'world', 'sources'] as const) {
      expect(introKeyFor(page, true, true)).toBe(`meraIntro.onDevice.${page}`);
      expect(introKeyFor(page, true, false)).toBe(`meraIntro.${page}`);
    }
    expect(introKeyFor('facts', true, true)).toBe('meraIntro.facts');
    expect(introKeyFor('stories', true, true)).toBe('trackedStories.followChatIntro');
  });

  it('checksNoWeb only on cloud with the setting off', () => {
    expect(introKeyFor('checks', false, false)).toBe('meraIntro.checksNoWeb');
  });
});

describe('pageStarters', () => {
  it('a starter drafts its own hint text', () => {
    expect(pageStarters('facts', true)).toEqual([
      { labelKey: 'meraHints.facts.change', draftKey: 'meraHints.facts.change' },
      { labelKey: 'meraHints.facts.remove', draftKey: 'meraHints.facts.remove' },
    ]);
  });

  it('One interest drafts name the fact', () => {
    expect(pageStarters('interest', true, 'Follows Indian startups')).toEqual([
      {
        labelKey: 'meraHints.interest.change',
        draftKey: 'meraDraft.changeInterest',
        draftOptions: { statement: 'Follows Indian startups' },
      },
      {
        labelKey: 'meraHints.interest.remove',
        draftKey: 'meraDraft.removeInterest',
        draftOptions: { statement: 'Follows Indian startups' },
      },
    ]);
  });
});
