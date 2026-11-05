// The Library's Saved page and the ••• item that fills Archive, over the in-memory DB with the real
// services, cards, sheet and toast queue. Mocked: the RN Modal spec, reanimated, the safe area,
// expo-router's focus effect, which the integration mock leaves inert, and the choice chip's floating
// menu, which is placed from native layout: its options here are plain buttons.
import React from 'react';
import { Platform, Pressable } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useFocusEffect } from 'expo-router';
import database from '@/lib/database';
import { useArticleActions } from '@/components/custom/cards/use-article-actions';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import SavedSuggestionsScreen from '@/components/custom/saved-suggestions/SavedSuggestionsScreen';
import { useToast } from '@/components/ui/toast';
import {
  deleteSavedSuggestion,
  getSavedList,
  isSuggestionSaved,
  moveSavedToList,
  saveStandaloneArticle,
} from '@/lib/database/services/saved-article-suggestion-service';
import * as settings from '@/lib/database/services/setting-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { __resetSavedStateForTests, type SavedList } from '@/lib/saved-state';
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
jest.mock('@/components/custom/nav/InlineChoiceChip', () => {
  const { Pressable } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ options, onChange, testID }: { options: string[]; onChange: (o: string) => void; testID: string }) =>
      options.map((o) => <Pressable key={o} testID={`${testID}-${o}`} onPress={() => onChange(o)} />),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
}));

beforeAll(async () => {
  await initI18nEn();
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
}, 60_000);
beforeEach(() => {
  closeAll();
  __resetSavedStateForTests();
  (useFocusEffect as jest.Mock).mockImplementation((cb: React.EffectCallback) => React.useEffect(cb, [cb]));
});
afterEach(closeAll);

const titled = (id: string) => newsArticle(id, { title_en_internal_only: `Headline ${id}`, title: `Headline ${id}` });
const saveTo = (id: string, list?: 'later' | 'archive') => saveStandaloneArticle(titled(id), undefined, list);
const row = (id: string) => screen.queryByTestId(`saved-item-${id}`);


function Page() {
  const [list, setList] = React.useState<SavedList>('later');
  return <SavedSuggestionsScreen list={list} onListChange={setList} />;
}

const openPage = async () => {
  await render(<Page />);
  await waitFor(() => expect(screen.getByTestId('saved-list-later')).toBeTruthy());
};
const press = async (id: string) => {
  await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
  await act(async () => {
    fireEvent.press(screen.getByTestId(id));
  });
};

describe('the two lists', () => {
  it('opens on Read later and the switch shows each list alone', async () => {
    await saveTo('later-1');
    await saveTo('arch-1', 'archive');
    await openPage();

    expect(row('later-1')).toBeTruthy();
    expect(row('arch-1')).toBeNull();
    expect(screen.getByText('1 to read')).toBeTruthy();

    await press('saved-list-archive');
    expect(row('later-1')).toBeNull();
    expect(row('arch-1')).toBeTruthy();
    expect(screen.getByText('1 archived')).toBeTruthy();
  });

  it('an empty Read later still reaches Archive, and hides the count row', async () => {
    await saveTo('arch-1', 'archive');
    await openPage();

    expect(screen.getByTestId('saved-empty')).toBeTruthy();
    expect(screen.queryByTestId('saved-title-row')).toBeNull();
    await press('saved-list-archive');
    expect(row('arch-1')).toBeTruthy();
  });

  it('an empty Archive explains how to fill it', async () => {
    await saveTo('later-1');
    await openPage();
    await press('saved-list-archive');
    expect(screen.getByTestId('saved-empty-archive')).toBeTruthy();
  });

  it('a move leaves this list at once and is in the other with no reload', async () => {
    await saveTo('a');
    await saveTo('b');
    await openPage();

    await act(async () => {
      await moveSavedToList('a', 'archive');
    });
    expect(row('a')).toBeNull();
    expect(screen.getByText('1 to read')).toBeTruthy();

    await press('saved-list-archive');
    expect(row('a')).toBeTruthy();
  });

  it('a removal takes the row and its group heading', async () => {
    await saveTo('a');
    await setSetting('saved_group_by', 'facts');
    await openPage();
    expect(screen.getByTestId('saved-group-other')).toBeTruthy();

    await act(async () => {
      await deleteSavedSuggestion('a');
    });
    expect(row('a')).toBeNull();
    expect(screen.queryByTestId('saved-group-other')).toBeNull();
    expect(screen.getByTestId('saved-empty')).toBeTruthy();
  });
});

describe('Group by', () => {
  it('opens on the stored choice with no flat first paint, and a pick is stored', async () => {
    await saveTo('a');
    await setSetting('saved_group_by', 'priority');
    await openPage();
    expect(screen.getByTestId('saved-group-no-priority')).toBeTruthy();

    await press('saved-group-chip-newest');
    await waitFor(() => expect(screen.queryByTestId('saved-group-no-priority')).toBeNull());
    await waitFor(async () => expect(await getSetting('saved_group_by')).toBe('newest'));
  });

  it('a load already running cannot undo a pick', async () => {
    await saveTo('a');
    await openPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = settings.getSetting;
    const spy = jest.spyOn(settings, 'getSetting').mockImplementation(async (key) => {
      // The old value is read first, then delayed past the pick.
      const stored = await real(key);
      await held;
      return stored;
    });
    const focused = (useFocusEffect as jest.Mock).mock.calls.at(-1)![0] as () => void;
    focused();
    await waitFor(() => expect(spy).toHaveBeenCalled());

    await press('saved-group-chip-priority');
    await waitFor(() => expect(screen.getByTestId('saved-group-no-priority')).toBeTruthy());
    spy.mockRestore();
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId('saved-group-no-priority')).toBeTruthy();
  });

  it('a pick of Facts files a save no fact holds under Other', async () => {
    await saveTo('a');
    await openPage();
    await press('saved-group-chip-facts');
    await waitFor(() => expect(screen.getByTestId('saved-group-other')).toBeTruthy());
    expect(row('a')).toBeTruthy();
    expect(await getSetting('saved_group_by')).toBe('facts');
  });
});

describe('the ••• item', () => {
  const article = titled('art-1');
  const subject: FeedbackSubject = {
    origin: 'article',
    surface: 'detail',
    articleId: 'art-1',
    title: 'Headline',
    publicationName: 'Die Zeit',
    countryCode: 'DEU',
    languageCode: 'de',
  };

  function Card() {
    const toast = useToast();
    toastManager.setToastInstance(toast);
    const actions = useArticleActions({ subject, article });
    const menu = useArticleMenu({ subject, archiveItem: actions.archiveItem });
    return (
      <>
        <Pressable testID="open-menu" onPress={() => menu.open()} />
        <Pressable testID="toggle-save" onPress={actions.onToggleSave} />
        {menu.element}
      </>
    );
  }

  // The deck is not mounted here: draw the newest card and press its Undo.
  const pressUndo = async () => {
    await waitFor(() => expect(useToastQueue.getState().entries.length).toBeGreaterThan(0), { timeout: 3000 });
    const entry = useToastQueue.getState().entries.at(-1)!;
    await render(<>{entry.render({ id: entry.id })}</>);
    await press('saved-list-undo');
  };

  it('archives an unsaved article, and Undo removes it again', async () => {
    await render(<Card />);
    await press('open-menu');
    expect(screen.getByText('Archive')).toBeTruthy();
    await press('menu-archive');
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('archive'), { timeout: 3000 });
    await pressUndo();
    await waitFor(async () => expect(await isSuggestionSaved('art-1')).toBe(false));
  }, 15000);

  it('the bookmark saves to Read later, and the item then offers the move both ways', async () => {
    await render(<Card />);
    await press('toggle-save');
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('later'));

    await press('open-menu');
    expect(screen.getByText('Move to Archive')).toBeTruthy();
    await press('menu-archive');
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('archive'), { timeout: 3000 });
    closeAll();

    await press('open-menu');
    expect(screen.getByText('Move to Read later')).toBeTruthy();
    await press('menu-archive');
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('later'), { timeout: 3000 });
    await pressUndo();
    await waitFor(async () => expect(await getSavedList('art-1')).toBe('archive'));
  }, 15000);

  it('a row removed behind the sheet\'s back moves nothing and shows no toast', async () => {
    await saveTo('art-1');
    await render(<Card />);
    await press('open-menu');
    await waitFor(() => expect(screen.getByText('Move to Archive')).toBeTruthy());
    // Only the row goes: the sheet is open, so the label it read still says saved.
    await database.write(async () => {
      await (await database.get('saved_article_suggestions').find('art-1')).destroyPermanently();
    });
    await press('menu-archive');
    expect(await getSavedList('art-1')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('open-menu')).toBeTruthy());
    expect(useToastQueue.getState().entries.length).toBe(0);
  }, 15000);
});
