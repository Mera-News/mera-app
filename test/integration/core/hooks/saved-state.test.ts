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
  getSavedOverride,
  publishSavedState,
  useSavedCount,
  useSavedOverride,
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
  it('is undefined until published, then follows every change', () => {
    const { result } = renderHook(() => useSavedOverride('a'));
    expect(result.current).toBeUndefined();

    act(() => publishSavedState('a', true));
    expect(result.current).toBe(true);

    act(() => publishSavedState('a', false));
    expect(result.current).toBe(false);
  });

  it('ignores other ids', () => {
    const { result } = renderHook(() => useSavedOverride('a'));
    act(() => publishSavedState('b', true));
    expect(result.current).toBeUndefined();
  });

  it('does not re-render on a write that changes nothing', () => {
    publishSavedState('a', true);
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useSavedOverride('a');
    });
    const before = renders;

    act(() => publishSavedState('a', true));

    expect(renders).toBe(before);
  });

  it('is undefined for an empty id even after other ids are published', () => {
    const { result } = renderHook(() => useSavedOverride(''));
    act(() => publishSavedState('a', true));
    expect(result.current).toBeUndefined();
  });

  it('stops listening once unmounted', () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      return useSavedOverride('a');
    });
    unmount();
    const before = renders;
    act(() => publishSavedState('a', true));
    expect(renders).toBe(before);
  });
});

describe('useSavedCount', () => {
  it('counts every id as saved until one is explicitly un-saved', () => {
    const ids = ['a', 'b', 'c'];
    const { result } = renderHook(() => useSavedCount(ids));
    expect(result.current).toBe(3);

    act(() => publishSavedState('b', false));
    expect(result.current).toBe(2);

    // A save, or an id outside the list, never changes the count.
    act(() => publishSavedState('a', true));
    act(() => publishSavedState('zzz', false));
    expect(result.current).toBe(2);

    act(() => publishSavedState('b', true));
    expect(result.current).toBe(3);
  });

  it('counts an empty list as zero', () => {
    const { result } = renderHook(() => useSavedCount([]));
    expect(result.current).toBe(0);
  });
});

describe('the saved-article write paths publish', () => {
  it('saveSuggestion flips the bookmark on, deleteSavedSuggestion flips it off', async () => {
    await seedArticles([{ id: 'art-1' }]);
    const s = (await suggestionRows())['art-1'];
    const { result } = renderHook(() => useSavedOverride(s._id));
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
    const { result } = renderHook(() => useSavedOverride('ghost'));

    await act(async () => {
      expect(await deleteSavedSuggestion('ghost')).toBe(false);
    });

    expect(result.current).toBe(false);
  });
});

describe('sign-out (bugs)', () => {
  // CO1. Saved-state overrides are module memory. The wipe erases the DB, the keychain and every
  // store, but nothing clears this map, so the next account on the device opens its Feed with the
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

  test.failing('CO1: sign-out clears saved-state overrides', async () => {
    const id = await saveThenSignOut();
    expect(getSavedOverride(id)).toBeUndefined();
  });

  test('CO1 (today): the previous account\'s saved-state override survives sign-out', async () => {
    const id = await saveThenSignOut();
    expect(await isSuggestionSaved(id)).toBe(false); // the wipe ran: the row is gone
    expect(getSavedOverride(id)).toBe(true); // the override still says saved
  });
});
