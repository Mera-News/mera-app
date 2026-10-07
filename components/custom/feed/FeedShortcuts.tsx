// "While Mera reads": the Feed's rare empty state (a first open, or a long gap
// with no background refresh) fills the wait with shortcuts to the reader's
// other pages: World, their first country, Saved, Stories. It sits BELOW the
// processing card or the caught-up card, never inside them (the processing
// card's height is fixed and summed).
//
//  - A shortcut shows only when its page has something in it: World always,
//    a country page when one exists, Saved with at least one saved article,
//    Stories with at least one followed story.
//  - Each caption is picked once per app process from that page's pool and
//    kept in memory only: nothing is stored, nothing counted (invariant 9).
//  - A row is one accessible button reading "<page>, <caption>"; its flag or
//    icon is decorative.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { PageId } from '@/components/custom/nav/page-registry';
import { navigateToPage } from '@/components/custom/nav/navigate-to-page';
import { flagEmoji } from '@/components/custom/nav/PageStrip';
import { COLORS } from '@/lib/theme/tokens';
import { useWorldPages } from '@/lib/explore/world-pages';
import { useForYouLastProcessingRunFinishedAt } from '@/lib/stores/selectors';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, StyleSheet, View } from 'react-native';

const GLYPH_HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** Per-process caption choice: one random index per pool, never stored. */
const picks = new Map<string, number>();
export function captionIndex(pool: string, size: number, random: () => number = Math.random): number {
  let i = picks.get(pool);
  if (i === undefined || i >= size) {
    i = Math.floor(random() * size);
    picks.set(pool, i);
  }
  return i;
}
/** Tests only. */
export function resetCaptionPicks(): void {
  picks.clear();
}

/** Lazy, so the card graph never loads the SQLite singleton at import. */
function savedService(): typeof import('@/lib/database/services/saved-article-suggestion-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/saved-article-suggestion-service');
}
function trackedService(): typeof import('@/lib/database/services/tracked-story-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/tracked-story-service');
}

function useHasSaved(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let live = true;
    savedService()
      .loadSavedItems()
      .then((items) => live && setHas(items.length > 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return has;
}

function useHasStories(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const sub = trackedService()
      .observeActive()
      .subscribe({ next: (rows) => setHas(rows.length > 0), error: () => setHas(false) });
    return () => sub.unsubscribe();
  }, []);
  return has;
}

interface Shortcut {
  readonly page: PageId;
  readonly title: string;
  readonly caption: string;
  readonly icon?: keyof typeof MaterialIcons.glyphMap;
  readonly flag?: string;
}

const FeedShortcuts: React.FC = () => {
  const { t } = useTranslation();
  const { pages } = useWorldPages();
  const hasSaved = useHasSaved();
  const hasStories = useHasStories();
  // A first open (no run has finished yet) with nothing followed: the Stories
  // row is an invitation instead (FinalFeed #1).
  const firstOpen = useForYouLastProcessingRunFinishedAt() === null;

  const country = pages.find((p) => p.id !== 'world');
  const worldCaptions = [t('feedShortcuts.world1'), t('feedShortcuts.world2')];
  const savedCaptions = [t('feedShortcuts.saved1'), t('feedShortcuts.saved2')];
  const storyCaptions = [t('feedShortcuts.stories1'), t('feedShortcuts.stories2')];

  const rows: Shortcut[] = [
    {
      page: 'world',
      title: t('tabs.world'),
      caption: worldCaptions[captionIndex('world', worldCaptions.length)],
      icon: 'public',
    },
  ];
  if (country) {
    const name = country.scope.label;
    const captions = [
      t('feedShortcuts.country1', { country: name }),
      t('feedShortcuts.country2', { country: name }),
    ];
    rows.push({
      page: country.id,
      title: name,
      caption: captions[captionIndex('country', captions.length)],
      flag: flagEmoji(country.id.slice('country:'.length)),
    });
  }
  if (hasSaved) {
    rows.push({
      page: 'saved',
      title: t('nav.page.saved'),
      caption: savedCaptions[captionIndex('saved', savedCaptions.length)],
      icon: 'bookmark',
    });
  }
  if (hasStories || firstOpen) {
    rows.push({
      page: 'stories',
      title: t('nav.page.stories'),
      caption: hasStories
        ? storyCaptions[captionIndex('stories', storyCaptions.length)]
        : t('feedShortcuts.storiesInvite'),
      icon: 'auto-awesome',
    });
  }

  return (
    <View style={styles.wrap} testID="feed-shortcuts">
      <Text size="sm" bold style={styles.header} accessibilityRole="header">
        {t('feedShortcuts.header')}
      </Text>
      {rows.map((r) => (
        <View key={r.page} style={styles.row} testID={`feed-shortcut-${r.page}-frame`}>
          <View style={styles.visual} pointerEvents="none" {...GLYPH_HIDDEN}>
            <View style={styles.tile}>
              {r.flag ? (
                <Text style={styles.flag}>{r.flag}</Text>
              ) : (
                <MaterialIcons name={r.icon ?? 'public'} size={22} color={COLORS.dark.accent} />
              )}
            </View>
            <View style={styles.texts}>
              <Text size="xs" bold style={{ color: '#F2BFA0' }} numberOfLines={1}>
                {r.title}
              </Text>
              <Text size="md" className="text-white" numberOfLines={2}>
                {r.caption}
              </Text>
            </View>
            <MaterialIcons
              name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'}
              size={22}
              color="rgb(163,163,163)"
            />
          </View>
          <Pressable
            onPress={() => navigateToPage(r.page)}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={`${r.title}, ${r.caption}`}
            testID={`feed-shortcut-${r.page}`}
          />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { gap: 10, marginTop: 4, marginHorizontal: 2 },
  header: { color: 'rgb(163,163,163)' },
  row: {
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.07)',
    justifyContent: 'center',
  },
  visual: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: 'rgba(231,138,83,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flag: { fontSize: 20, lineHeight: 24 },
  texts: { flex: 1, gap: 2 },
});

export default FeedShortcuts;
