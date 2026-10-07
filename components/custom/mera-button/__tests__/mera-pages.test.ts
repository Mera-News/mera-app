import type { SurfaceId } from '@/components/custom/nav/page-registry';
import {
  chatContextFor,
  hintKeys,
  interestFactId,
  introKeyFor,
  pageKeyFor,
  pageStarters,
} from '../mera-pages';

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
  it('keeps the owner Profile line first, as the existing key', () => {
    expect(hintKeys('profile', true)[0]).toBe('profile.meraInviteReturning');
  });

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
      'checks', 'library', 'profile', 'facts', 'sources', 'settings',
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
