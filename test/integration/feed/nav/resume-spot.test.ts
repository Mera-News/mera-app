// The resume spot's runtime: capture from a live navigation state, rebuild it on
// a fresh navigator. The navigator is a small fake at the router edge that turns
// replace/push/back into the nested state expo-router keeps; everything else is
// the real module.
import {
  __resetResumeSpotForTests,
  __setResumeSpotDepsForTests,
  captureSpot,
  isRestoreHidden,
  lastRestoreMissing,
  noteActivePage,
  registerScrollTarget,
  reportRestoredScreen,
  restoreSpot,
  type ResumeScrollTarget,
  type ResumeSpot,
  type SpotScreen,
} from '@/lib/navigation/resume-spot';

interface Route {
  name: string;
  key: string;
  params?: Record<string, string>;
}

function fakeNavigator() {
  let n = 0;
  const model = { tab: null as string | null, tabStack: [] as Route[], rootStack: [] as Route[] };
  const calls: string[] = [];
  let failPush: string | null = null;
  const key = (name: string) => `${name}-${++n}`;
  const router = {
    replace: (href: string) => {
      calls.push(`replace ${href}`);
      model.tab = href.split('/').pop()!;
      model.tabStack = [{ name: 'index', key: key('index') }];
      model.rootStack = [];
    },
    push: ({ pathname, params }: { pathname: string; params: Record<string, string> }) => {
      calls.push(`push ${pathname}`);
      if (failPush && pathname.endsWith(failPush)) throw new Error('boom');
      const parts = pathname.split('/');
      const name = parts.pop()!;
      const route = { name, key: key(name), params };
      if (parts.includes('app_container')) model.tabStack.push(route);
      else model.rootStack.push(route);
    },
    back: () => {
      calls.push('back');
      if (model.rootStack.length) model.rootStack.pop();
      else if (model.tabStack.length > 1) model.tabStack.pop();
    },
  };
  const getRootState = () => {
    const loggedIn = [
      ...(model.tab
        ? [{ name: 'app_container', key: 'ac', state: { index: 0, routes: [{ name: model.tab, key: 'tab', state: { index: model.tabStack.length - 1, routes: model.tabStack } }] } }]
        : [{ name: 'index', key: 'gate' }]),
      ...model.rootStack,
    ];
    return { index: 0, routes: [{ name: '__root', state: { index: 0, routes: [{ name: 'logged-in', state: { index: loggedIn.length - 1, routes: loggedIn } }] } }] };
  };
  return {
    model,
    calls,
    failOn: (route: string) => (failPush = route),
    topKey: () => (model.rootStack.at(-1) ?? model.tabStack.at(-1))!.key,
    deps: {
      router: () => router,
      navRef: () => ({ isReady: () => true, getRootState }),
    },
  };
}

let clock = 0;
let nav: ReturnType<typeof fakeNavigator>;
let pages: string[];
const missing = new Set<string>();

function install(extra: Record<string, unknown> = {}) {
  __setResumeSpotDepsForTests({
    ...nav.deps,
    setPendingPage: (p) => pages.push(p),
    arrangeOpen: () => false,
    probe: (s: SpotScreen) => {
      const id = Object.values(s.params)[0];
      return s.route === 'story-timeline' || s.route === 'interest' ? Promise.resolve(!missing.has(id)) : undefined;
    },
    nextFrame: async () => {
      clock += 16;
    },
    now: () => clock,
    ...extra,
  });
}

beforeEach(() => {
  __resetResumeSpotForTests();
  nav = fakeNavigator();
  pages = [];
  missing.clear();
  clock = 0;
  install();
});

const deep: ResumeSpot = {
  v: 1,
  tab: 'feed',
  page: 'feed',
  tabStack: [{ route: 'interest', params: { factId: 'f1', statement: 'Rain' } }],
  rootStack: [{ route: 'story-timeline', params: { trackedStoryId: 's1' } }],
  scroll: { y: 640 },
};

describe('restoreSpot', () => {
  it('asks for the page, opens the tab, then pushes each screen with its params', async () => {
    await expect(restoreSpot(deep)).resolves.toBe('restored');
    expect(pages).toEqual(['feed']);
    expect(nav.calls).toEqual([
      'replace /logged-in/app_container/feed',
      'push /logged-in/app_container/feed/interest',
      'push /logged-in/story-timeline',
    ]);
    expect(nav.model.tabStack[1].params).toEqual({ factId: 'f1', statement: 'Rain' });
  });

  it('lands on the screen under a story that is gone, with no scroll', async () => {
    missing.add('s1');
    await expect(restoreSpot(deep)).resolves.toBe('fallback');
    expect(lastRestoreMissing()).toBe('story');
    expect(nav.calls).toEqual(['replace /logged-in/app_container/feed', 'push /logged-in/app_container/feed/interest']);
  });

  it('a gone fact cuts everything above it and has no special copy', async () => {
    missing.add('f1');
    await expect(restoreSpot(deep)).resolves.toBe('fallback');
    expect(lastRestoreMissing()).toBeNull();
    expect(nav.calls).toEqual(['replace /logged-in/app_container/feed']);
  });

  it('fails when a navigation call throws', async () => {
    nav.failOn('story-timeline');
    await expect(restoreSpot(deep)).resolves.toBe('failed');
  });

  it('fails when a push never shows in the state', async () => {
    install({ router: () => ({ replace: () => undefined, push: () => undefined, back: () => undefined }) });
    await expect(restoreSpot(deep)).resolves.toBe('failed');
  });

  it('fails on a spot of another version', async () => {
    await expect(restoreSpot({ ...deep, v: 2 } as unknown as ResumeSpot)).resolves.toBe('failed');
    expect(nav.calls).toEqual([]);
  });

  it('pushes nothing more once its signal aborts (the gate hit its cap)', async () => {
    const ctl = new AbortController();
    // The fake lands every call at once, so make the first settle wait a frame.
    const real = nav.deps.navRef();
    let first = true;
    install({
      navRef: () => ({
        isReady: () => true,
        getRootState: () => {
          if (first) {
            first = false;
            return { routes: [] };
          }
          return real.getRootState();
        },
      }),
      nextFrame: async () => {
        clock += 16;
        ctl.abort();
      },
    });
    await expect(restoreSpot(deep, { signal: ctl.signal })).resolves.toBe('failed');
    expect(nav.calls).toEqual(['replace /logged-in/app_container/feed']);
  });

  it('fails once its own budget runs out', async () => {
    install({ now: () => (clock += 1000) });
    await expect(restoreSpot(deep)).resolves.toBe('failed');
  });

  it('pops a restored article that reports itself gone, and says so', async () => {
    const spot: ResumeSpot = { ...deep, tabStack: [], rootStack: [{ route: 'article-detail', params: { articleId: 'a1' } }] };
    install({
      nextFrame: async () => {
        clock += 16;
        if (nav.model.rootStack.length) reportRestoredScreen(nav.topKey(), 'missing');
      },
    });
    await expect(restoreSpot(spot)).resolves.toBe('fallback');
    expect(lastRestoreMissing()).toBe('story');
    expect(nav.calls.at(-1)).toBe('back');
  });

  it('pops a restored publication that reports gone after the rebuild resolved', async () => {
    const spot: ResumeSpot = { ...deep, tabStack: [], rootStack: [{ route: 'publication', params: { publisherId: 'p1' } }] };
    await expect(restoreSpot(spot)).resolves.toBe('restored');
    reportRestoredScreen(nav.topKey(), 'missing');
    expect(nav.calls.at(-1)).toBe('back');
  });

  it('does not fail when a notification tap opens a screen on top mid-rebuild', async () => {
    const spot: ResumeSpot = { ...deep, rootStack: [] };
    let pushed = false;
    install({
      nextFrame: async () => {
        clock += 16;
        if (!pushed && nav.model.tabStack.length > 1) {
          pushed = true;
          nav.model.rootStack.push({ name: 'article-detail', key: 'notif', params: { articleId: 'n1' } });
        }
      },
    });
    await expect(restoreSpot(spot)).resolves.toBe('restored');
  });
});

describe('scroll', () => {
  function list(height: number): ResumeScrollTarget & { y: number } {
    const t = {
      y: 0,
      getOffset: () => t.y,
      // A list that only grows as it renders toward the goal: each call reaches 300pt further.
      scrollTo: (y: number) => {
        t.y = Math.min(y, Math.min(height, t.y + 300));
      },
    };
    return t;
  }

  it('hides the top list until a long scroll lands, then shows it', async () => {
    await restoreSpot(deep);
    const key = nav.topKey();
    expect(isRestoreHidden(key)).toBe(true);
    const t = list(5000);
    registerScrollTarget(key, t);
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(t.y).toBe(640);
    expect(isRestoreHidden(key)).toBe(false);
  });

  it('a Feed whose anchor row is gone lands at the top, never at the old offset', async () => {
    const spot: ResumeSpot = { ...deep, tabStack: [], rootStack: [], scroll: { y: 2400, anchorId: 'gone', anchorDelta: 12 } };
    await restoreSpot(spot);
    const t = Object.assign(list(5000), { scrollToAnchor: jest.fn(() => 'missing' as const) });
    t.y = 50;
    registerScrollTarget(nav.topKey(), t);
    await new Promise((r) => setImmediate(r));
    expect(t.scrollToAnchor).toHaveBeenCalledWith('gone', 12);
    expect(t.y).toBe(0);
  });
});

describe('captureSpot', () => {
  it('round-trips: what it captures, restoreSpot rebuilds, and capture reads back the same', async () => {
    await restoreSpot(deep);
    noteActivePage('feed', 'feed');
    const t = { getOffset: () => 640, scrollTo: () => undefined };
    registerScrollTarget(nav.topKey(), t);
    expect(captureSpot()).toEqual(deep);
  });

  it('is null while World is being arranged', async () => {
    await restoreSpot({ ...deep, tab: 'world', page: 'world', tabStack: [], rootStack: [] });
    install({ arrangeOpen: () => true });
    expect(captureSpot()).toBeNull();
  });

  it('is null on the gate, and never throws', () => {
    expect(captureSpot()).toBeNull();
    install({ navRef: () => ({ isReady: () => true, getRootState: () => { throw new Error('x'); } }) });
    expect(captureSpot()).toBeNull();
  });
});
