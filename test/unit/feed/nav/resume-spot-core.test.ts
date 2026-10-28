import {
  parseResumeSpot,
  planRestore,
  cleanParams,
  ROOT_ROUTES,
  readNavShape,
  spotFromShape,
  topRouteKey,
  truncateSpot,
  type NavStateLike,
  type ResumeSpot,
} from '@/lib/navigation/resume-spot-core';

/** A root state the way expo-router nests it: __root > logged-in > app_container > tab stack. */
function state(opts: {
  tab: string;
  tabStack?: { name: string; params?: object }[];
  rootStack?: { name: string; params?: object }[];
  gateFirst?: boolean;
}): NavStateLike {
  const tabStack = [{ name: 'index', key: 'tabroot' }, ...(opts.tabStack ?? []).map((r, i) => ({ ...r, key: `t${i}` }))];
  const loggedIn = [
    ...(opts.gateFirst ? [{ name: 'index', key: 'gate' }] : []),
    {
      name: 'app_container',
      key: 'ac',
      state: {
        index: 0,
        routes: [{ name: opts.tab, key: `${opts.tab}-k`, state: { index: tabStack.length - 1, routes: tabStack } }],
      },
    },
    ...(opts.rootStack ?? []).map((r, i) => ({ ...r, key: `r${i}` })),
  ];
  return {
    index: 0,
    routes: [{ name: '__root', state: { index: 0, routes: [{ name: 'logged-in', state: { index: loggedIn.length - 1, routes: loggedIn } }] } }],
  };
}

describe('readNavShape + spotFromShape', () => {
  it('reads a tab root with its page', () => {
    const shape = readNavShape(state({ tab: 'library' }));
    expect(topRouteKey(shape!)).toBe('tabroot');
    expect(spotFromShape(shape, 'saved')).toEqual({ v: 1, tab: 'library', page: 'saved', tabStack: [], rootStack: [] });
  });

  it('reads a topic feed in the Feed stack with an article on top, keeping only schema params', () => {
    const shape = readNavShape(
      state({
        tab: 'feed',
        tabStack: [{ name: 'interest', params: { factId: 'f1', statement: 'Rain', junk: 'x', via: 3 } }],
        rootStack: [{ name: 'article-detail', params: { articleId: 'a1', screen: 'nested' } }],
      }),
    );
    expect(topRouteKey(shape!)).toBe('r0');
    expect(spotFromShape(shape, 'feed')).toEqual({
      v: 1,
      tab: 'feed',
      page: 'feed',
      tabStack: [{ route: 'interest', params: { factId: 'f1', statement: 'Rain' } }],
      rootStack: [{ route: 'article-detail', params: { articleId: 'a1' } }],
    });
  });

  it('ignores the gate route left under the tab container', () => {
    expect(spotFromShape(readNavShape(state({ tab: 'world', gateFirst: true })), 'world')?.tab).toBe('world');
  });

  it.each([
    ['a stub or unknown root screen', { tab: 'feed', rootStack: [{ name: 'feedback-request', params: { id: '1' } }] }],
    ['PIN setup', { tab: 'you', tabStack: [{ name: 'app-lock' }] }],
    ['a backup restore', { tab: 'you', tabStack: [{ name: 'backup', params: { restore: '1' } }] }],
    ['a screen missing its required param', { tab: 'feed', rootStack: [{ name: 'story-timeline', params: {} }] }],
    ['a publication with neither id nor name', { tab: 'feed', rootStack: [{ name: 'publication', params: { country: 'IND' } }] }],
    ['a tab screen pushed into the wrong tab', { tab: 'world', tabStack: [{ name: 'interest', params: { factId: 'f' } }] }],
  ])('is null for %s', (_label, opts) => {
    expect(spotFromShape(readNavShape(state(opts)), null)).toBeNull();
  });

  it('is null outside the tab container (a gate, sign-in)', () => {
    expect(readNavShape({ routes: [{ name: 'login' }] })).toBeNull();
    expect(readNavShape({ routes: [{ name: 'logged-in', state: { routes: [{ name: 'index' }] } }] })).toBeNull();
  });

  it('keeps Search but never a query', () => {
    const spot = spotFromShape(readNavShape(state({ tab: 'world', rootStack: [{ name: 'search', params: { q: 'secret' } }] })), 'world');
    expect(spot?.rootStack).toEqual([{ route: 'search', params: {} }]);
  });
});

describe('parseResumeSpot', () => {
  const spot: ResumeSpot = {
    v: 1,
    tab: 'you',
    page: 'settings',
    tabStack: [{ route: 'fact', params: { factId: 'f1' } }],
    rootStack: [{ route: 'publication', params: { name: 'The Hindu', country: 'IND' } }],
  };

  it('survives a JSON round trip', () => {
    expect(parseResumeSpot(JSON.parse(JSON.stringify(spot)))).toEqual(spot);
  });

  it.each([
    ['another version', { ...spot, v: 2 }],
    ['an unknown tab', { ...spot, tab: 'profile' }],
    ['a route off the allowlist', { ...spot, rootStack: [{ route: 'onboarding', params: {} }] }],
    ['a non-array stack', { ...spot, tabStack: 'x' }],
    ['garbage', 'spot'],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(parseResumeSpot(raw)).toBeNull();
  });

  it('keeps only the path from an older bundle marker that carries a scroll (owner: no scroll restore)', () => {
    expect(parseResumeSpot({ ...spot, scroll: { y: 2400, anchorId: 'row', anchorDelta: 12 } })).toEqual(spot);
  });
});

describe('planRestore', () => {
  it('asks for the page, opens the tab, then pushes tab screens before root screens', () => {
    const steps = planRestore({
      v: 1,
      tab: 'feed',
      page: 'notifications',
      tabStack: [{ route: 'interest', params: { factId: 'f1' } }],
      rootStack: [{ route: 'story-timeline', params: { trackedStoryId: 's1' } }],
    });
    expect(steps).toEqual([
      { kind: 'page', page: 'notifications' },
      { kind: 'tab', href: '/logged-in/app_container/feed' },
      { kind: 'push', href: '/logged-in/app_container/feed/interest', params: { factId: 'f1' }, chain: ['tab:feed', 't:interest'] },
      { kind: 'push', href: '/logged-in/story-timeline', params: { trackedStoryId: 's1' }, chain: ['tab:feed', 't:interest', 'r:story-timeline'] },
    ]);
  });

  it('truncates at a missing screen', () => {
    const spot: ResumeSpot = {
      v: 1,
      tab: 'feed',
      page: null,
      tabStack: [{ route: 'interest', params: { factId: 'f1' } }],
      rootStack: [
        { route: 'story-timeline', params: { trackedStoryId: 's1' } },
        { route: 'article-detail', params: { articleId: 'a1' } },
      ],
    };
    expect(truncateSpot(spot, 1)).toEqual({ ...spot, rootStack: [] });
    expect(truncateSpot(spot, 2)).toEqual({ ...spot, rootStack: [spot.rootStack[0]] });
    expect(truncateSpot(spot, 0)).toEqual({ ...spot, tabStack: [], rootStack: [] });
  });
});

describe('cleanParams keeps trackedStoryId on both detail routes', () => {
  it.each(['article-detail', 'suggestion-detail'])('%s', (route) => {
    const schema = ROOT_ROUTES[route];
    const required = route === 'article-detail' ? { articleId: 'a1' } : { articleSuggestionId: 's1' };
    expect(cleanParams(schema, { ...required, trackedStoryId: 't1', junk: 'x' })).toEqual({
      ...required,
      trackedStoryId: 't1',
    });
  });
});
