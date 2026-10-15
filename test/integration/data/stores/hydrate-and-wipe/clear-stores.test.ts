// clearAllStores and clearPreviousUserData against the real stores, the in-memory
// WatermelonDB, the stateful secure store and AsyncStorage.
// Replaces lib/stores/__tests__/index.test.ts (minus its 21 export smoke tests,
// which a successful import of '@/lib/stores' proves).
import AsyncStorage from '@react-native-async-storage/async-storage';
import database from '@/lib/database';
import {
  clearAllStores,
  clearPreviousUserData,
  useConfigPanelStore,
  useFloatingChatStore,
  useForYouStore,
  useMeraProtocolStore,
  useUIStore,
  useUserStore,
} from '@/lib/stores';
import { addFact } from '@/lib/database/services/fact-service';
import { persistUserPersona } from '@/lib/database/services/user-persona-service';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  knownSourceNamesForPublisher,
  rememberPublisherSourceNames,
} from '@/lib/database/services/publisher-source-names';
import { loadPageOrders, usePageOrderStore } from '@/lib/navigation/page-order';
import { useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import { usePendingPageStore } from '@/components/custom/nav/navigate-to-page';
import {
  DEFAULT_CORNER,
  hydrateMeraButtonCorner,
  useMeraCornerStore,
} from '@/components/custom/mera-button/corner';
import { loadFeedViewPrefs, useFeedViewPrefs } from '@/components/custom/feed/feed-view-prefs';
import { readLastKnownTier, rememberLastKnownTier } from '@/lib/subscription/last-known-tier';
import { getReadHold, hydrateReadHold, isReadHeld, setReadHold } from '@/lib/subscription/read-hold';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { useTutorialsStore } from '@/lib/stores/tutorials-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { PERFORMANCE_OVERRIDE_KEY } from '@/lib/performance/performance-mode';
import { THEME_STORAGE_KEY } from '@/lib/theme/theme-store';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';
import { secureStoreDump, signInFixtureAccount } from '@/test/helpers';
import { flush, resetHydrationMemory } from './support';

// expo-constants (integration mock) has slug 'exampleapp', which prefixes the keychain keys.
const COOKIE = 'exampleapp_cookie';
const SESSION_DATA = 'exampleapp_session_data';
const PIN_RECORD = 'exampleapp_pin_record';
const BACKUP_KEY = 'exampleapp_backup_key';
const PIPELINE_KEY = 'async_pipeline_privkey';

beforeEach(() => {
  resetHydrationMemory();
  // resetHydrationMemory covers the hydrated stores; these are cleared by clearAllStores too.
  useUIStore.setState(useUIStore.getInitialState(), true);
  useConfigPanelStore.setState(useConfigPanelStore.getInitialState(), true);
  useFloatingChatStore.getState().reset();
  useSubscriptionStore.setState(useSubscriptionStore.getInitialState(), true);
});

afterEach(async () => {
  jest.restoreAllMocks();
  // clearAllStores fires clearData() and the user-store deletes without awaiting.
  await flush();
});

const tableCount = (table: string) => database.get(table).query().fetchCount();

/** One row in each of the six tables hasLocalUserData() treats as "a user lives here", plus settings. */
async function seedUserData(): Promise<void> {
  await addFact('I follow Formula 1 racing');
  await persistUserPersona('old-user', {
    _id: 'persona-1',
    userId: 'old-user',
    preferredNotificationWindow: [9, 18],
    notificationsEnabled: true,
    expoPushToken: null,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    language_codes: ['en'],
    processingMode: ProcessingMode.Cloud,
    llmWarningCount: 0,
    lastSuccessfulCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
  });
  await recordPublicationVisit({ publicationName: 'Gazette', countryCode: 'NLD', articleId: 'a-1' });
  await trackStory({ articleId: 'a-1', title: 'A followed story', originSurface: 'feed' });
  // No service writes a bare suggestion row without a whole sync; one row is enough here.
  await database.write(() =>
    database.get('article_suggestions').create((r) => {
      (r as unknown as { serverId: string }).serverId = 'suggestion-1';
    }),
  );
  await setSetting('cached_user_id', 'old-user');
}

const USER_TABLES = [
  'facts',
  'user_personas',
  'publication_visits',
  'tracked_stories',
  'article_suggestions',
] as const;

describe('clearAllStores: database', () => {
  it('empties every user table', async () => {
    await seedUserData();
    for (const table of USER_TABLES) expect(await tableCount(table)).toBeGreaterThan(0);

    await expect(clearAllStores()).resolves.toBeUndefined();

    for (const table of USER_TABLES) expect(await tableCount(table)).toBe(0);
    expect(await getSetting('cached_user_id')).toBeNull();
  });

  it('forgets the last-known subscription tier even if the database reset leaves the row behind', async () => {
    // The guarantee must not silently depend on unsafeResetDatabase staying total
    // (a straggling recordResolvedTier would otherwise hand user A's tier to user B).
    await rememberLastKnownTier('pro');
    jest.spyOn(database, 'unsafeResetDatabase').mockResolvedValue(undefined as never);
    await clearAllStores();
    expect(await readLastKnownTier()).toBeNull();
  });
});

describe('clearAllStores: Zustand stores', () => {
  it('resets for-you, user, ui, config-panel, floating-chat', async () => {
    useForYouStore.setState({ articleCount: 12, relevantArticleCount: 4, lastSyncAt: 1 });
    useUserStore.setState({ userId: 'old-user', userEmail: 'a@example.com', needsReauth: true, lastFetchedAt: 5 });
    useUIStore.getState().openModal('logout');
    useConfigPanelStore.getState().openPanel();
    useFloatingChatStore.getState().expand();

    await clearAllStores();

    expect(useForYouStore.getState()).toMatchObject({ articleCount: 0, relevantArticleCount: 0, lastSyncAt: null });
    expect(useUserStore.getState()).toMatchObject({
      userId: null,
      userEmail: null,
      userPersona: null,
      needsReauth: false,
      lastFetchedAt: null,
    });
    expect(useUIStore.getState().modals.logout.isOpen).toBe(false);
    expect(useConfigPanelStore.getState().isOpen).toBe(false);
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);
  });

  it('resets mera-protocol, subscription, feed-order, related-sort and tutorials', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    useSubscriptionStore.setState({ serverTier: 'pro', isPremium: true });
    useFeedOrderStore.setState({ order: ['a', 'b'], builtAt: 1 });
    useRelatedSortStore.setState({ mode: 'newest', hydrated: true });
    useTutorialsStore.setState({ completed: new Set(['chapter-1']), menuSeen: true, hydrated: true });

    await clearAllStores();

    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.Cloud);
    expect(useSubscriptionStore.getState()).toMatchObject({ serverTier: null, isPremium: false });
    expect(useFeedOrderStore.getState().order).toEqual([]);
    expect(useRelatedSortStore.getState()).toMatchObject({ mode: 'relevance', hydrated: false });
    expect(useTutorialsStore.getState()).toMatchObject({ menuSeen: false, hydrated: false });
    expect(useTutorialsStore.getState().completed.size).toBe(0);
  });
});

describe('clearAllStores: module mirrors', () => {
  it('forgets the publisher source-name map, so the next account never inherits it', async () => {
    rememberPublisherSourceNames('pub-1', ['BBC News', 'BBC']);
    expect(knownSourceNamesForPublisher('pub-1')).not.toBeNull();
    await clearAllStores();
    expect(knownSourceNamesForPublisher('pub-1')).toBeNull();
  });

  it('forgets page orders and their memoised load, so a later load reads the database again', async () => {
    await setSetting('nav_order_world', JSON.stringify(['country:DE', 'world']));
    await loadPageOrders();
    expect(usePageOrderStore.getState()).toMatchObject({ stored: ['country:DE', 'world'], hydrated: true });

    await clearAllStores();
    expect(usePageOrderStore.getState()).toMatchObject({ stored: null, hydrated: false });

    // The new account's row. Without the memo reset this load returns the old promise.
    await setSetting('nav_order_world', JSON.stringify(['world', 'country:FR']));
    await loadPageOrders();
    expect(usePageOrderStore.getState().stored).toEqual(['world', 'country:FR']);
  });

  it('clears the nav shell surface and any pending page jump', async () => {
    const initialSurface = useCurrentSurfaceStore.getState();
    useCurrentSurfaceStore.setState({ arrangeOpen: true });
    usePendingPageStore.setState({ request: { page: 'stats', origin: null, at: 1 } });

    await clearAllStores();

    expect(useCurrentSurfaceStore.getState()).toEqual(initialSurface);
    expect(usePendingPageStore.getState().request).toBeNull();
  });

  it('puts the Mera button back in the default corner and re-reads the row on the next hydrate', async () => {
    const other = DEFAULT_CORNER === 'tl' ? 'br' : 'tl';
    await setSetting('mera_button_corner', other);
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: other, hydrated: true });

    await clearAllStores();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: DEFAULT_CORNER, hydrated: false });

    await setSetting('mera_button_corner', 'tr');
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState().corner).toBe('tr');
  });

  it('puts the Feed view prefs back to their defaults and re-reads the rows on the next load', async () => {
    await setSetting('feed_view', 'sectioned');
    await setSetting('feed_minimap', 'true');
    await loadFeedViewPrefs();
    expect(useFeedViewPrefs.getState()).toEqual({ view: 'sectioned', minimap: true });

    await clearAllStores();
    expect(useFeedViewPrefs.getState()).toEqual({ view: 'continuous', minimap: false });

    await setSetting('feed_view', 'sectioned');
    await loadFeedViewPrefs();
    expect(useFeedViewPrefs.getState().view).toBe('sectioned');
  });

  it('forgets the read hold, so the next account never starts held', async () => {
    await setReadHold({ resetAt: Date.now() + 60 * 60 * 1000, used: 1 });
    expect(isReadHeld()).toBe(true);

    await clearAllStores();
    expect(isReadHeld()).toBe(false);
    expect(getReadHold()).toEqual({ resetAt: null, used: null });
    // The row went with the database, so the next hydrate finds nothing either.
    await hydrateReadHold();
    expect(isReadHeld()).toBe(false);
  });

  it('clears the last-known subscription tier', async () => {
    await rememberLastKnownTier('pro');
    expect(await readLastKnownTier()).toBe('pro');
    await clearAllStores();
    expect(await readLastKnownTier()).toBeNull();
  });
});

describe('clearAllStores: device-level preferences', () => {
  it('keeps the theme and the Lite mode override, which live in AsyncStorage', async () => {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'light');
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'lite');
    await seedUserData();

    await clearAllStores();

    expect(await AsyncStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(await AsyncStorage.getItem(PERFORMANCE_OVERRIDE_KEY)).toBe('lite');
  });
});

describe('clearPreviousUserData', () => {
  async function seedSessionAndKeychain(): Promise<void> {
    await signInFixtureAccount();
    await secureStore.setItemAsync(COOKIE, 'cookie-of-the-incoming-account');
    await secureStore.setItemAsync(SESSION_DATA, 'session-of-the-incoming-account');
    await secureStore.setItemAsync(PIN_RECORD, 'pin-of-the-old-account');
    await secureStore.setItemAsync(BACKUP_KEY, 'backup-key-of-the-old-account');
    await secureStore.setItemAsync(PIPELINE_KEY, 'e2ee-key-of-the-old-account');
  }

  it("PE9b today: is a no-op with no cached user (the old owner's facts and PIN survive)", async () => {
    await seedUserData();
    await database.write(async () => {
      const row = (await database.get('settings').query().fetch()).find(
        (r) => (r as unknown as { key: string }).key === 'cached_user_id',
      );
      await row?.destroyPermanently();
    });
    await seedSessionAndKeychain();

    await expect(clearPreviousUserData('new-user')).resolves.toBeUndefined();

    expect(await tableCount('facts')).toBe(1);
    expect(secureStoreDump()[PIN_RECORD]).toBe('pin-of-the-old-account');
  });

  it('is a no-op when the cached user is the incoming one, so a cold start keeps the returning user data', async () => {
    await seedUserData();
    await rememberLastKnownTier('pro');
    await seedSessionAndKeychain();

    await clearPreviousUserData('old-user');

    expect(await tableCount('facts')).toBe(1);
    expect(await readLastKnownTier()).toBe('pro');
    expect(secureStoreDump()[PIN_RECORD]).toBe('pin-of-the-old-account');
  });

  it('runs the FULL wipe, keeping only the session, when the cached user differs', async () => {
    await seedUserData();
    await seedSessionAndKeychain();
    usePinStore.setState({ pinSet: true, lockEnabled: true });
    await AsyncStorage.setItem(THEME_STORAGE_KEY, 'light');
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, 'lite');

    await clearPreviousUserData('new-user');

    // The incoming account's session survives...
    const keychain = secureStoreDump();
    expect(keychain[COOKIE]).toBe('cookie-of-the-incoming-account');
    expect(keychain[SESSION_DATA]).toBe('session-of-the-incoming-account');
    // ...and everything else the previous account left does not: keychain, PIN gate, database.
    expect(keychain[PIN_RECORD]).toBeUndefined();
    expect(keychain[BACKUP_KEY]).toBeUndefined();
    expect(keychain[PIPELINE_KEY]).toBeUndefined();
    expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false });
    for (const table of USER_TABLES) expect(await tableCount(table)).toBe(0);
    // The install boundary reads "no has_launched and no cached_user_id" as a fresh install
    // and would delete the kept session, so the wipe writes has_launched back.
    expect(await getSetting('has_launched')).toBe('1');
    expect(await getSetting('cached_user_id')).toBeNull();
    // Device-level preferences are not the account's.
    expect(await AsyncStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(await AsyncStorage.getItem(PERFORMANCE_OVERRIDE_KEY)).toBe('lite');
  });

  it('propagates a failed wipe, and leaves the data behind as the marker that finishes it', async () => {
    await seedUserData();
    await seedSessionAndKeychain();
    jest.spyOn(database, 'unsafeResetDatabase').mockRejectedValueOnce(new Error('db locked'));

    await expect(clearPreviousUserData('new-user')).rejects.toThrow('db locked');

    // Keychain first, database last: the populated database is what the next launch sees.
    expect(await tableCount('facts')).toBe(1);
    expect(secureStoreDump()[PIN_RECORD]).toBeUndefined();
    expect(secureStoreDump()[COOKIE]).toBe('cookie-of-the-incoming-account');
  });
});
