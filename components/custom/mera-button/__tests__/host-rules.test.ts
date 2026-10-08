jest.mock('@/lib/stores/floating-chat-store', () => ({ useFloatingChatStore: { getState: jest.fn() } }));

import { buttonContextFor, lastKnown, meraButtonVisible, OVERLAY_PROPS, routeKindFor } from '../host-rules';

describe('routeKindFor', () => {
  it('classifies tabs, their pushed screens, Search and the article pages', () => {
    expect(routeKindFor(['logged-in', 'app_container', 'feed'])).toBe('tab');
    expect(routeKindFor(['logged-in', 'app_container', 'you', 'facts'])).toBe('tab');
    expect(routeKindFor(['logged-in', 'search'])).toBe('search');
    expect(routeKindFor(['logged-in', 'article-detail'])).toBe('article');
    expect(routeKindFor(['logged-in', 'suggestion-detail'])).toBe('article');
  });

  it('puts everything else outside the allowlist', () => {
    expect(routeKindFor(['logged-in', 'onboarding'])).toBe('other');
    expect(routeKindFor(['logged-in', 'feedback-request'])).toBe('other');
    expect(routeKindFor(['auth'])).toBe('other');
    expect(routeKindFor([])).toBe('other');
  });
});

describe('meraButtonVisible', () => {
  const shown = { route: 'tab' as const, hydrated: true, chatOpen: false, arrangeOpen: false, keyboardUp: false };

  it('shows on every allowed route with nothing in the way', () => {
    for (const route of ['tab', 'article', 'search'] as const) {
      expect(meraButtonVisible({ ...shown, route })).toBe(true);
    }
  });

  it('never shows outside the allowlist, before hydration, or with the chat open', () => {
    expect(meraButtonVisible({ ...shown, route: 'other' })).toBe(false);
    expect(meraButtonVisible({ ...shown, hydrated: false })).toBe(false);
    expect(meraButtonVisible({ ...shown, chatOpen: true })).toBe(false);
    expect(meraButtonVisible({ ...shown, route: 'article', chatOpen: true })).toBe(false);
  });

  it('hides for the keyboard and Arrange on a tab, but rides the keyboard on Search and articles', () => {
    expect(meraButtonVisible({ ...shown, keyboardUp: true })).toBe(false);
    expect(meraButtonVisible({ ...shown, arrangeOpen: true })).toBe(false);
    expect(meraButtonVisible({ ...shown, route: 'search', keyboardUp: true })).toBe(true);
    expect(meraButtonVisible({ ...shown, route: 'article', keyboardUp: true })).toBe(true);
  });
});

describe('lastKnown', () => {
  it('keeps the last real value while the next one is in flight', () => {
    expect(lastKnown('feed', null)).toBe('feed');
    expect(lastKnown('feed', 'world')).toBe('world');
    expect(lastKnown<string>(null, null)).toBeNull();
  });
});

describe('buttonContextFor', () => {
  const article = { articleId: 'a1', title: 'Headline' };

  it('opens Mera on the article on an article page', () => {
    expect(buttonContextFor('article', article)).toEqual({
      kind: 'article-suggestion',
      articleId: 'a1',
      suggestionId: undefined,
      articleTitle: 'Headline',
    });
  });

  it("leaves tabs and Search to the page's own context", () => {
    expect(buttonContextFor('tab', article)).toBeUndefined();
    expect(buttonContextFor('search', null)).toBeUndefined();
  });

  it('falls back to the page context when the article has no id', () => {
    expect(buttonContextFor('article', { title: 'x' })).toBeUndefined();
    expect(buttonContextFor('article', null)).toBeUndefined();
  });
});

describe('OVERLAY_PROPS', () => {
  it('keeps the full-screen wrapper out of the accessibility tree and flattenable', () => {
    for (const key of [
      'accessible',
      'accessibilityViewIsModal',
      'accessibilityElementsHidden',
      'importantForAccessibility',
      'testID',
      'nativeID',
      'collapsable',
    ]) {
      expect(OVERLAY_PROPS).not.toHaveProperty(key);
    }
    expect(OVERLAY_PROPS.pointerEvents).toBe('box-none');
  });
});
