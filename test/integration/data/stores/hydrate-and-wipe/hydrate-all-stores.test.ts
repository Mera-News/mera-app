// hydrateAllStores against the real stores, the in-memory WatermelonDB and MSW.
// Replaces lib/database/__tests__/hydrate-stores.test.ts.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hydrateAllStores } from '@/lib/database/hydrate-stores';
import { persistUserPersona } from '@/lib/database/services/user-persona-service';
import { setSetting } from '@/lib/database/services/setting-service';
import {
  PUBLISHER_SOURCE_NAMES_SETTING,
  knownSourceNamesForPublisher,
} from '@/lib/database/services/publisher-source-names';
import {
  backupCadence,
  backupProviderId,
  backupWifiOnly,
} from '@/lib/backup/backup-settings';
import { usePageOrderStore } from '@/lib/navigation/page-order';
import { MERA_BUTTON_LOOK_KEY, useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { writePerformanceOverride } from '@/lib/performance/performance-mode';
import { useMeraCornerStore } from '@/components/custom/mera-button/corner';
import { useFeedViewPrefs } from '@/components/custom/feed/feed-view-prefs';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useForYouPrefsStore } from '@/lib/stores/for-you-prefs-store';
import { usePublicationDisplayStore } from '@/lib/stores/publication-display-store';
import { useRelatedSortStore } from '@/lib/stores/related-sort-store';
import { useStartupTabStore } from '@/lib/stores/startup-tab-store';
import { useTextScaleStore } from '@/lib/stores/text-scale-store';
import { chapterCompletedKey, useTutorialsStore } from '@/lib/stores/tutorials-store';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';
import type { UserPersona } from '@/lib/account-service';
import {
  flush,
  resetHydrationMemory,
  restoreFaults,
} from './support';


/** A hydrate whose outcome the test may never look at: afterEach still drains it. */
const inflight: Promise<unknown>[] = [];
function run(): Promise<void> {
  const p = hydrateAllStores();
  inflight.push(p.catch(() => undefined));
  return p;
}

beforeEach(() => {
  resetHydrationMemory();
  usePublicationDisplayStore.setState({ language: null, names: {} });
});

afterEach(async () => {
  restoreFaults();
  await Promise.allSettled(inflight.splice(0));
  // Fire-and-forget tails (translation sweep, display-name save) finish here.
  await flush();
});

/**
 * The persona carries language_codes[0] === the seeded app language, so the
 * fire-and-forget language reconcile after hydration is a no-op and puts
 * nothing on the wire.
 */
function persona(overrides: Partial<UserPersona> = {}): UserPersona {
  return {
    _id: 'persona-1',
    userId: 'user-1',
    preferredNotificationWindow: [9, 18],
    notificationsEnabled: true,
    expoPushToken: null,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    language_codes: ['de'],
    processingMode: ProcessingMode.OnDevice,
    llmWarningCount: 0,
    lastSuccessfulCompletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2026-01-02T00:00:00Z').toISOString(),
    ...overrides,
  };
}

async function seedEverySetting(): Promise<void> {
  // user-store
  await setSetting('cached_user_id', 'user-1');
  await setSetting('cached_user_email', 'reader@example.com');
  await setSetting('needs_reauth', '1');
  await persistUserPersona('user-1', persona());
  // the other stores
  await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
  await setSetting('onboarding_state', JSON.stringify({ preferences: { countries: ['NL'], newsImpact: 'local' } }));
  await setSetting('app_language', 'de');
  await setSetting('last_authenticated_user_id', 'user-1');
  await setSetting('startup_tab', 'library');
  await setSetting(chapterCompletedKey('feed-basics'), 'true');
  await setSetting('tutorial_menu_seen', 'true');
  await setSetting('text_scale', '1.3');
  await setSetting('related_articles_sort', 'newest');
  await setSetting('for_you_recent_24h_only', '1');
  await setSetting('blur_images', '1');
  await writePerformanceOverride('lite');
  await AsyncStorage.setItem(MERA_BUTTON_LOOK_KEY, 'dark');
  // the five non-store entries
  await setSetting(
    PUBLISHER_SOURCE_NAMES_SETTING,
    JSON.stringify({ v: 1, publishers: [['pub-1', ['bbc news', 'bbc']]] }),
  );
  await setSetting('nav_order_world', JSON.stringify(['country:DE', 'world']));
  await setSetting('mera_button_corner', 'tl');
  await setSetting('feed_view', 'sectioned');
  await setSetting('feed_minimap', 'true');
  await setSetting('feed_algo', JSON.stringify({ seenBelowFold: false, keepDays: 3 }));
  await setSetting('backup_cadence', 'daily');
  await setSetting('backup_provider', 'icloud');
  await setSetting('backup_wifi_only', '0');
}

describe('hydrateAllStores: seeded settings come back', () => {
  beforeEach(async () => {
    await seedEverySetting();
    await expect(run()).resolves.toBeUndefined();
  });

  it('startup tab, tutorials, text scale, related sort, for-you prefs and blur images', () => {
    expect(useStartupTabStore.getState()).toMatchObject({ startupTab: 'library', hydrated: true });
    const tutorials = useTutorialsStore.getState();
    expect(tutorials.hydrated).toBe(true);
    expect(tutorials.menuSeen).toBe(true);
    expect(tutorials.completed.has('feed-basics')).toBe(true);
    expect(useTextScaleStore.getState()).toMatchObject({ scale: 1.3, hydrated: true });
    expect(useRelatedSortStore.getState()).toMatchObject({ mode: 'newest', hydrated: true });
    expect(useForYouPrefsStore.getState()).toMatchObject({ recent24hOnly: true, hydrated: true });
    expect(useBlurImagesStore.getState()).toMatchObject({ blurImages: true, hydrated: true });
  });

  it('display prefs read the device-level AsyncStorage keys', () => {
    expect(useDisplayPrefsStore.getState()).toMatchObject({
      performanceOverride: 'lite',
      liteMode: true,
      meraButtonLook: 'dark',
      hydrated: true,
    });
  });

  it('the five non-store mirrors: source names, page orders, Mera corner, feed view prefs, backup settings', () => {
    expect(knownSourceNamesForPublisher('pub-1')).toEqual(['bbc news', 'bbc']);
    expect(usePageOrderStore.getState()).toMatchObject({ stored: ['country:DE', 'world'], hydrated: true });
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'tl', hydrated: true });
    expect(useFeedViewPrefs.getState()).toMatchObject({
      view: 'sectioned',
      minimap: true,
      // A partial row: the stored fields, every other one at its default.
      algo: { skippedIsRead: true, keepDays: 3, mediumStaysAbove: true, seenBelowFold: false, highSinks: false },
    });
    expect(backupCadence()).toBe('daily');
    expect(backupProviderId()).toBe('icloud');
    expect(backupWifiOnly()).toBe(false);
  });
});
