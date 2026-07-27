import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { VStack } from '@/components/ui/vstack';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ArticleCardBase — the full-size feed card CHROME, extracted verbatim from
 * `ArticleSuggestionContainer`'s `isCard` branch. Purely presentational and
 * decoupled from any data model: callers pass a flat view-model plus two slots.
 *
 * Layout (unchanged, pixel-identical to the old container card):
 *   Pressable → elevated Card → optional 192px (h-48) hero image (with an
 *   `imageFailed` fallback) → VStack{ meta row (+ metaAccessory), title,
 *   children }.
 *
 * • `children`      — variant chrome rendered under the title (reason box, fact
 *                     chips, actions row, …).
 * • `metaAccessory` — a small adornment rendered directly under the meta row,
 *                     right-aligned (e.g. the __DEV__ relevance readout).
 */
export interface ArticleCardBaseProps {
  imageUrl?: string | null;
  titleEnglish?: string | null;
  titleOriginal?: string;
  sourceLanguage?: string;
  pubDate?: string | null;
  languageCode?: string | null;
  publicationName?: string | null;
  countryCode?: string | null;
  isNew?: boolean;
  moreSourcesCount?: number;
  recyclingKey?: string;
  /** Dims the whole card (~0.55 opacity) — used to fade already-opened rows in
   *  the Earlier zone. No visual change when undefined. */
  dimmed?: boolean;
  /** Marks the card as already-read — shows a small eye icon in the meta row
   *  next to the time group, instead of dimming. The Dashboard surfaces use
   *  this. */
  read?: boolean;
  /** Renders as a "floating" neumorphic card instead of the default `Card`
   *  chrome: rounded-2xl, a hairline low-opacity border, a subtle drop shadow,
   *  and the same `bg-background-0` surface tone the default Card already
   *  uses — just a touch more elevated-looking against the pure-black page.
   *  Used by Dashboard's list treatment (FactFeedScreen),
   *  which own the shared horizontal list inset (~12px) so the rounded edges
   *  read against the page. Vertical spacing between elements and the
   *  `read`/`dimmed` behaviors are unaffected. Default false — every other
   *  surface is pixel-identical. */
  flat?: boolean;
  onPress?: () => void;
  children?: React.ReactNode;
  metaAccessory?: React.ReactNode;
  /** A control row pinned at the bottom of the card, OUTSIDE the region the
   *  `overlay` covers (e.g. the like/dislike action bar) — stays visible while
   *  the overlay is up. When omitted the card is unchanged (pixel-identical). */
  footer?: React.ReactNode;
  /** A floating panel that covers the card's content region (hero + meta + title
   *  + children) but NOT the `footer`. Clipped to the card's rounded corners by
   *  its `overflow-hidden`. Used for the inline feedback surface. */
  overlay?: React.ReactNode;
}

const ArticleCardBaseImpl: React.FC<ArticleCardBaseProps> = ({
  imageUrl,
  titleEnglish,
  titleOriginal,
  sourceLanguage,
  pubDate,
  languageCode,
  publicationName,
  countryCode,
  isNew = false,
  moreSourcesCount,
  recyclingKey,
  dimmed = false,
  read = false,
  flat = false,
  onPress,
  children,
  metaAccessory,
  footer,
  overlay,
}) => {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);

  const displayTitle = titleEnglish || t('feed.newsCluster');
  const showImage = !!imageUrl && !imageFailed;

  const innerContent = (
    <>
      {/* Content region — the `overlay` (when present) floats over exactly this,
          clipped to the card's rounded corners by the outer overflow-hidden. */}
      <Box className="relative">
        {showImage && (
          <Box
            className={
              flat ? 'w-full h-48 overflow-hidden rounded-t-2xl' : 'w-full h-48 overflow-hidden rounded-t-lg'
            }
          >
            <Image
              source={{ uri: imageUrl! }}
              alt={displayTitle}
              className="w-full h-full"
              resizeMode="cover"
              recyclingKey={recyclingKey}
              onError={() => setImageFailed(true)}
            />
          </Box>
        )}
        {/* When a footer is present it owns the bottom padding, so the content
            VStack drops its own (pb-0) to avoid a doubled gap. */}
        <VStack className={footer ? 'px-4 pt-4' : 'p-4'} space="sm">
          <Box>
            <ArticleMetaRow
              pubDate={pubDate}
              languageCode={languageCode}
              publicationName={publicationName}
              countryCode={countryCode}
              variant="card"
              isNew={isNew}
              moreSourcesCount={moreSourcesCount}
              read={read}
            />
            {metaAccessory ? (
              <HStack className="self-end mt-1">{metaAccessory}</HStack>
            ) : null}
          </Box>
          <TranslatableDynamic
            as="heading"
            text={displayTitle}
            originalText={titleOriginal}
            originalLanguage={sourceLanguage}
            size="md"
            className="leading-6"
            showToggle={false}
          />
          {children}
        </VStack>
        {overlay ? (
          // Absolute fill of the content region. Claims stray taps so the grey
          // backdrop doesn't fall through to the card's open-article press.
          <Box className="absolute inset-0" onStartShouldSetResponder={() => true}>
            {overlay}
          </Box>
        ) : null}
      </Box>
      {footer ? <Box className="px-4 pb-4 pt-2">{footer}</Box> : null}
    </>
  );

  return (
    <Pressable onPress={onPress} style={dimmed ? { opacity: 0.75 } : undefined}>
      {flat ? (
        // Shadow lives on this outer, non-clipping Box — RN drops a view's
        // shadow the moment that same view also sets `overflow: hidden`, so
        // the rounded/clipped surface (border + bg + hero image) has to be a
        // separate inner Box for the floating look to actually show a shadow.
        <Box className="mb-3 rounded-2xl shadow-hard-2">
          <Box className="rounded-2xl overflow-hidden bg-background-0 border border-white/10">
            {innerContent}
          </Box>
        </Box>
      ) : (
        <Card variant="elevated" size="md" className="mb-4 overflow-hidden">
          {innerContent}
        </Card>
      )}
    </Pressable>
  );
};

// Memoized (default shallow compare): with a stable onPress + flat view-model
// props, a row bails out of re-rendering when nothing it displays changed —
// mirrors the old ArticleSuggestionContainer.memo contract (perf A2).
export const ArticleCardBase = React.memo(ArticleCardBaseImpl);

export default ArticleCardBase;
