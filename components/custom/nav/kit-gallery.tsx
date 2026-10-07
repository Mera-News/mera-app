// S1's section of the navx2 P2 kit gallery (app/dev-kit.tsx): every kit piece
// this area owns, in every state. Dev only; deleted in P13.
//
// Pills: segmented (Feed, Library, You) at rest and mid-swipe, with a leading
// slot, and World's scrolling row with its edge fade and search button. The
// expanding chip collapsed, and disabled; tap it to open.

import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';

import InlineChoiceChip from './InlineChoiceChip';
import PageExplainerSheet from './PageExplainerSheet';
import PageStrip from './PageStrip';
import PageTitleRow from './PageTitleRow';
import type { PageExplainer, PageId } from './page-registry';
import type { PagePill } from './types';

const HOURS = [6, 12, 24, 48] as const;
const NEW_DOT = () => ({ visible: true });
const noop = () => undefined;

const TOP_HEADLINES: PageExplainer = {
  titleKey: 'sources.topHeadlines',
  paragraphKeys: ['world.explainer.top1', 'world.explainer.window', 'world.explainer.same'],
  chapter: 'explore',
};
/** A chapter that does not exist yet: the sheet shows Got it alone. */
const NO_CHAPTER: PageExplainer = { ...TOP_HEADLINES, chapter: 'library' };

function Label({ children }: { readonly children: string }) {
  const colors = useColors();
  return (
    <Text size="xs" style={{ color: colors.ink3, marginTop: 16, marginBottom: 6 }}>
      {children}
    </Text>
  );
}

function Strip({
  pages,
  start,
  progressAt,
  variant,
  leading,
}: {
  readonly pages: readonly PagePill[];
  readonly start: PageId;
  readonly progressAt: number;
  readonly variant: 'segmented' | 'scroll';
  readonly leading?: React.ReactNode;
}) {
  const [active, setActive] = useState<PageId>(start);
  const progress = useSharedValue(progressAt);
  return (
    <PageStrip
      tabLabel="Tab"
      pages={pages}
      activeId={active}
      onSelect={(id) => {
        setActive(id);
        progress.value = pages.findIndex((p) => p.id === id);
      }}
      quickSettings={null}
      variant={variant}
      progress={progress}
      leading={leading}
      trailing={variant === 'scroll' ? { kind: 'search', onPress: noop } : undefined}
      onLongPressPill={variant === 'scroll' ? noop : undefined}
    />
  );
}

export default function KitGallery() {
  const { t } = useTranslation();
  const colors = useColors();
  const [hours, setHours] = useState<(typeof HOURS)[number]>(24);
  const [sheet, setSheet] = useState<PageExplainer | null>(null);

  const feed: PagePill[] = [
    { id: 'feed', label: t('tabs.deck'), icon: 'article' },
    { id: 'stories', label: t('nav.page.stories'), icon: 'layers', useDot: NEW_DOT },
  ];
  const library: PagePill[] = [
    { id: 'saved', label: t('nav.page.saved') },
    { id: 'checks', label: t('nav.page.checks') },
    { id: 'visited', label: t('nav.page.visited') },
  ];
  const you: PagePill[] = [
    { id: 'profile', label: t('tabs.profile') },
    { id: 'settings', label: t('tabs.settings') },
    { id: 'saved', label: t('notificationCenter.title') },
  ];
  const world: PagePill[] = [
    { id: 'world', label: t('tabs.world'), icon: 'public' },
    ...['DE', 'NL', 'GB', 'IN', 'FR', 'JP'].map((a2) => ({
      id: `country:${a2}` as PageId,
      label: a2,
      flagAlpha2: a2,
    })),
  ];
  const statusIcon = (
    <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: colors.ink }} />
  );

  return (
    <View testID="kit-nav">
      <Label>Segmented, Feed (leading slot, dot on Stories)</Label>
      <Strip pages={feed} start="feed" progressAt={0} variant="segmented" leading={statusIcon} />
      <Label>Segmented, mid-swipe (progress 0.5)</Label>
      <Strip pages={feed} start="feed" progressAt={0.5} variant="segmented" />
      <Label>Segmented, Library</Label>
      <Strip pages={library} start="checks" progressAt={1} variant="segmented" />
      <Label>Segmented, You</Label>
      <Strip pages={you} start="profile" progressAt={0} variant="segmented" />
      <Label>Scroll, World (scroll it: pills fade at both ends)</Label>
      <Strip pages={world} start="world" progressAt={0} variant="scroll" />

      <Label>Expanding chip (tap to open)</Label>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', minHeight: 44, alignItems: 'center' }}>
        <InlineChoiceChip
          options={HOURS}
          value={hours}
          labelOf={(h) => t(`explore.window.label${h}`)}
          a11yLabelOf={(h) => t(`explore.window.a11y${h}`)}
          onChange={setHours}
          testID="kit-chip"
        />
      </View>
      <Label>Title row: title, ?, trailing chip (tap ? for the sheet)</Label>
      <PageTitleRow
        title={t('sources.topHeadlines')}
        onExplain={() => setSheet(TOP_HEADLINES)}
        trailing={
          <InlineChoiceChip
            options={HOURS}
            value={hours}
            labelOf={(h) => t(`explore.window.label${h}`)}
            a11yLabelOf={(h) => t(`explore.window.a11y${h}`)}
            onChange={setHours}
            testID="kit-title-chip"
          />
        }
        testID="kit-title"
      />
      <Label>Title row, ? opens a sheet with no tutorial yet (Got it alone)</Label>
      <PageTitleRow title={t('tabs.library')} onExplain={() => setSheet(NO_CHAPTER)} testID="kit-title-nochapter" />
      <PageExplainerSheet explainer={sheet} open={sheet !== null} onClose={() => setSheet(null)} />

      <Label>Expanding chip, disabled (first load)</Label>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', minHeight: 44, alignItems: 'center' }}>
        <InlineChoiceChip
          options={HOURS}
          value={24}
          labelOf={(h) => t(`explore.window.label${h}`)}
          a11yLabelOf={(h) => t(`explore.window.a11y${h}`)}
          onChange={noop}
          disabled
          testID="kit-chip-disabled"
        />
      </View>
    </View>
  );
}
