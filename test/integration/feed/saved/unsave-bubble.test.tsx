// The filled bookmark's bubble on the article page's real action row: real DB, services, sheet and
// toast queue. Mocked: the RN Modal spec, reanimated, the safe area. Native layout is faked at the
// measure and the panel's onLayout, the only two numbers placement reads.
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ArticleFeedbackPrompt } from '@/components/custom/ArticleFeedbackPrompt';
import { useArticleActions } from '@/components/custom/cards/use-article-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useToast } from '@/components/ui/toast';
import {
  getSavedList,
  isSuggestionSaved,
  saveStandaloneArticle,
} from '@/lib/database/services/saved-article-suggestion-service';
import { activeHolds } from '@/lib/app-restart';
import { __resetSavedStateForTests } from '@/lib/saved-state';
import { toastManager } from '@/lib/toast-manager';
import { closeAll, useToastQueue } from '@/lib/toast/toast-queue';
import { initI18nEn } from '@/test/helpers';
import { newsArticle } from '../detail/seed';

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? <View>{children}</View> : null,
  };
});
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
}));

const MockNativeMethods = jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default;
const placeBookmark = (y: number) =>
  MockNativeMethods.measureInWindow.mockImplementation((cb: (...n: number[]) => void) => cb(300, y, 27, 27));

const article = newsArticle('art-1', { title_en_internal_only: 'Headline', title: 'Headline' });
const subject: FeedbackSubject = { origin: 'article', surface: 'detail', articleId: 'art-1', title: 'Headline' };

function ArticleRow() {
  const toast = useToast();
  toastManager.setToastInstance(toast);
  const actions = useArticleActions({ subject, article });
  return (
    <ArticleFeedbackPrompt
      articleId="art-1"
      title="Headline"
      article={article}
      save={{ saved: actions.saved, onToggle: actions.onToggleSave }}
      archiveItem={actions.archiveItem}
    />
  );
}

const mountRow = async () => {
  await render(<ArticleRow />);
  await act(async () => {});
};
const press = async (id: string) => {
  await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};
const bubble = () => screen.queryByTestId('unsave-bubble');
const openBubble = async () => {
  await waitFor(() => expect(screen.getByTestId('card-action-save').props.accessibilityState.selected).toBe(true));
  await press('card-action-save');
};

beforeAll(async () => {
  await initI18nEn();
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
}, 60_000);
beforeEach(() => {
  closeAll();
  __resetSavedStateForTests();
  placeBookmark(300);
});
afterEach(closeAll);

describe('the filled bookmark', () => {
  it('an empty bookmark still saves straight to Read later, with no bubble', async () => {
    await mountRow();
    await press('card-action-save');
    expect(bubble()).toBeNull();
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('later'));
  });

  it('a tap opens the bubble and unsaves nothing, and says what it does', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await waitFor(() => expect(screen.getByLabelText('Saved')).toBeTruthy());
    expect(screen.getByTestId('card-action-save').props.accessibilityHint).toBe('Archive, Remove');

    await openBubble();
    expect(bubble()).toBeTruthy();
    expect(screen.getByTestId('card-action-save').props.accessibilityState.expanded).toBe(true);
    expect(await isSuggestionSaved('art-1')).toBe(true);
  });

  it('Archive moves the row, closes the bubble and offers Undo', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    await press('unsave-bubble-move');

    expect(bubble()).toBeNull();
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('archive'));
    await waitFor(() => expect(useToastQueue.getState().entries.length).toBe(1));
    const entry = useToastQueue.getState().entries[0];
    await render(<>{entry.render({ id: entry.id })}</>);
    expect(screen.getByTestId('saved-list-undo')).toBeTruthy();
  });

  it('an archived article offers Read later in place of Archive', async () => {
    await saveStandaloneArticle(article, undefined, 'archive');
    await mountRow();
    await openBubble();
    await waitFor(() => expect(screen.getByLabelText('Read later')).toBeTruthy());
    expect(screen.queryByLabelText('Archive')).toBeNull();

    await press('unsave-bubble-move');
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('later'));
  });

  it('Remove unsaves through the existing path and closes the bubble', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    await press('unsave-bubble-remove');

    expect(bubble()).toBeNull();
    await waitFor(async () => expect(await isSuggestionSaved('art-1')).toBe(false));
  });

  it('a tap outside closes it and changes nothing', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    await press('unsave-bubble-outside');

    expect(bubble()).toBeNull();
    expect(await getSavedList('art-1')).toBe('later');
    expect(useToastQueue.getState().entries.length).toBe(0);
  });

  it('holds the automatic restart only while open', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    expect(activeHolds('ota')).toEqual([]);
    await openBubble();
    expect(activeHolds('ota')).toEqual(['overlay:sheet']);
    await press('unsave-bubble-outside');
    expect(activeHolds('ota')).toEqual([]);
  });

  it('a row removed behind its back reports the failure and never an Undo', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    const { default: database } = jest.requireActual('@/lib/database');
    await database.write(async () => {
      await (await database.get('saved_article_suggestions').find('art-1')).destroyPermanently();
    });
    await press('unsave-bubble-move');
    await waitFor(() => expect(useToastQueue.getState().entries.length).toBe(1));
    const entry = useToastQueue.getState().entries[0];
    await render(<>{entry.render({ id: entry.id })}</>);
    expect(screen.queryByTestId('saved-list-undo')).toBeNull();
    expect(screen.getByText("That didn't work. Try again.")).toBeTruthy();
  });
});

describe('placement', () => {
  // Jest's window is 750 x 1334.
  const place = async () => {
    await fireEvent(screen.getByTestId('unsave-bubble'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 160, height: 100 } },
    });
    const box = StyleSheet.flatten(screen.getByTestId('unsave-bubble-box').props.style) as { top: number };
    const panel = StyleSheet.flatten(screen.getByTestId('unsave-bubble').props.style) as {
      transform: { translateX: number }[];
    };
    return { top: box.top, centre: 375 + panel.transform[0].translateX };
  };

  it('hangs under a bookmark with room below', async () => {
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    expect((await place()).top).toBe(300 + 27 + 6);
  });

  it('sits above a bookmark at the bottom of the screen', async () => {
    placeBookmark(1250);
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    expect((await place()).top).toBe(1250 - 6 - 100);
  });

  it('stays inside the window at its side', async () => {
    MockNativeMethods.measureInWindow.mockImplementation((cb: (...n: number[]) => void) => cb(740, 300, 27, 27));
    await saveStandaloneArticle(article);
    await mountRow();
    await openBubble();
    expect((await place()).centre).toBe(750 - 12 - 80);
  });
});
