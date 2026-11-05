// saved-state: the app-wide "is this article saved?" override channel, and the two write paths that
// publish into it (saveSuggestion / deleteSavedSuggestion), over the in-memory DB.
import { act, renderHook } from '@testing-library/react-native';
import {
  deleteSavedSuggestion,
  isSuggestionSaved,
  saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { signOutAndWipe } from '@/lib/security/local-wipe';
import { signInFixtureAccount } from '@/test/helpers';
import {
  __resetSavedStateForTests,
  getSavedListOverride,
  getSavedOverride,
  publishSavedList,
  publishSavedState,
  resetSavedState,
  useSavedList,
  useSavedOverride,
  useSavedStateVersion,
} from '@/lib/saved-state';
import { seedArticles, suggestionRows } from '../sync/seed';

beforeEach(() => __resetSavedStateForTests());
afterAll(() => __resetSavedStateForTests());

describe('publishSavedState / getSavedOverride', () => {
  it('has no override for an id nobody has touched', () => {
    expect(getSavedOverride('a')).toBeUndefined();
  });

  it('stores the last published flag per id', () => {
    publishSavedState('a', true);
    publishSavedState('b', false);
    publishSavedState('a', false);
    expect(getSavedOverride('a')).toBe(false);
    expect(getSavedOverride('b')).toBe(false);
  });

  it('ignores an empty id on both sides', () => {
    publishSavedState('', true);
    expect(getSavedOverride('')).toBeUndefined();
  });
});

describe('useSavedOverride', () => {
  it('is undefined until published, then follows every change', async () => {
    const { result } = await renderHook(() => useSavedOverride('a'));
    expect(result.current).toBeUndefined();

    await act(() => publishSavedState('a', true));
    expect(result.current).toBe(true);

    await act(() => publishSavedState('a', false));
    expect(result.current).toBe(false);
  });

  it('ignores other ids', async () => {
    const { result } = await renderHook(() => useSavedOverride('a'));
    await act(() => publishSavedState('b', true));
    expect(result.current).toBeUndefined();
  });

  it('does not re-render on a write that changes nothing', async () => {
    publishSavedState('a', true);
    let renders = 0;
    await renderHook(() => {
      renders += 1;
      return useSavedOverride('a');
    });
    const before = renders;

    await act(() => publishSavedState('a', true));

    expect(renders).toBe(before);
  });

  it('is undefined for an empty id even after other ids are published', async () => {
    const { result } = await renderHook(() => useSavedOverride(''));
    await act(() => publishSavedState('a', true));
    expect(result.current).toBeUndefined();
  });

  it('stops listening once unmounted', async () => {
    let renders = 0;
    const { unmount } = await renderHook(() => {
      renders += 1;
      return useSavedOverride('a');
    });
    await unmount();
    const before = renders;
    await act(() => publishSavedState('a', true));
    expect(renders).toBe(before);
  });
});

describe('list overrides', () => {
  it('has none for an id nobody has touched', () => {
    expect(getSavedListOverride('a')).toBeUndefined();
  });

  it('reports the last list, and the version moves only on a change', async () => {
    const list = await renderHook(() => useSavedList('a'));
    const version = await renderHook(() => useSavedStateVersion());
    const before = version.result.current;
    expect(list.result.current).toBeUndefined();

    await act(async () => publishSavedList('a', 'archive'));
    expect(list.result.current).toBe('archive');
    expect(version.result.current).toBe(before + 1);

    await act(async () => publishSavedList('a', 'archive'));
    expect(version.result.current).toBe(before + 1);
  });

  it('a removal moves the version too, so the Saved page drops the row', async () => {
    const version = await renderHook(() => useSavedStateVersion());
    const before = version.result.current;
    await act(async () => publishSavedState('a', false));
    expect(version.result.current).toBe(before + 1);
  });

  it('sign-out clears them', () => {
    publishSavedList('a', 'archive');
    resetSavedState();
    expect(getSavedListOverride('a')).toBeUndefined();
  });
});

describe('the saved-article write paths publish', () => {
  it('saveSuggestion flips the bookmark on, deleteSavedSuggestion flips it off', async () => {
    await seedArticles([{ id: 'art-1' }]);
    const s = (await suggestionRows())['art-1'];
    const { result } = await renderHook(() => useSavedOverride(s._id));
    expect(result.current).toBeUndefined();

    await act(async () => {
      await saveSuggestion(s);
    });
    expect(result.current).toBe(true);
    expect(await isSuggestionSaved(s._id)).toBe(true);

    await act(async () => {
      expect(await deleteSavedSuggestion(s._id)).toBe(true);
    });
    expect(result.current).toBe(false);
    expect(await isSuggestionSaved(s._id)).toBe(false);
  });

  it('deleting an id that was never saved still corrects the surface that thought it was', async () => {
    const { result } = await renderHook(() => useSavedOverride('ghost'));

    await act(async () => {
      expect(await deleteSavedSuggestion('ghost')).toBe(false);
    });

    expect(result.current).toBe(false);
  });
});

describe('sign-out', () => {
  // CO1. Saved-state overrides are module memory. The wipe erases the DB, the keychain and every
  // store, and must clear this map too, or the next account on the device opens its Feed with the
  // previous account's bookmarks still filled (and its un-save tap hits a row that does not exist).
  async function saveThenSignOut() {
    await signInFixtureAccount();
    await seedArticles([{ id: 'art-1' }]);
    const s = (await suggestionRows())['art-1'];
    await saveSuggestion(s);
    expect(getSavedOverride(s._id)).toBe(true);

    await signOutAndWipe();
    return s._id;
  }

  test('CO1: sign-out clears saved-state overrides', async () => {
    const id = await saveThenSignOut();
    expect(getSavedOverride(id)).toBeUndefined();
  });
});
