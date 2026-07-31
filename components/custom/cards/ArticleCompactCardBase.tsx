import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import { ArticleImagePlaceholder } from '@/components/custom/cards/ArticleImagePlaceholder';
import {
  CARDS_USE_GLASS,
  CardGlassPlate,
  GLASS_CARD_EDGE,
} from '@/components/custom/cards/CardGlassPlate';
import { SourceFlag } from '@/components/custom/SourceFlag';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';

/**
 * ArticleCompactCardBase — the compact card CHROME. Purely presentational:
 * callers pass a flat view-model plus slots.
 *
 * Layout: Pressable → elevated Card → flex-row (min-height 128, grows with the
 * title) [ ¼-width image (article image, else the generic placeholder) | ¾-width
 * content stacked in three zones:
 *   1. meta row  — time + language (ArticleMetaRow, flag hidden) + `metaAccessory`
 *   2. title     — up to 3 lines
 *   3. footer    — `footerAccessory` (left) · country flag + publisher name (right)
 * ].
 *
 * • `metaAccessory`   — small adornment at the right of the meta row (e.g. the
 *                       __DEV__ cluster-confidence chip).
 * • `footerAccessory` — a control at the far left of the footer row (e.g. the
 *                       RelevanceChip). Absent ⇒ the footer is just the source
 *                       identity, still right-aligned.
 */

export interface ArticleCompactCardBaseProps {
  imageUrl?: string | null;
  titleEnglish?: string | null;
  titleOriginal?: string;
  sourceLanguage?: string;
  pubDate?: string | null;
  languageCode?: string | null;
  countryCode?: string | null;
  /** Publisher display name — shown in the footer (next to the country flag). */
  publicationName?: string | null;
  isNew?: boolean;
  recyclingKey?: string;
  /** Dims the whole row (~0.75 opacity) — used to fade already-opened rows in
   *  the Earlier zone. No visual change when undefined. */
  dimmed?: boolean;
  /** Marks the row as already-read. Draws NO indicator — the eye glyph was
   *  deliberately removed — it only suppresses the NEW badge in the meta row.
   *  The seen mechanism itself is untouched. The Dashboard surfaces use this. */
  read?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  metaAccessory?: React.ReactNode;
  footerAccessory?: React.ReactNode;
  /** Optional testID passthrough for the card's root Pressable — used by
   *  concrete card components to expose a stable, driver-targetable id
   *  (e.g. `card-${articleId}`). No visual/behavioral effect. */
  testID?: string;
}

const ArticleCompactCardBaseImpl: React.FC<ArticleCompactCardBaseProps> = ({
  imageUrl,
  titleEnglish,
  titleOriginal,
  sourceLanguage,
  pubDate,
  languageCode,
  countryCode,
  publicationName,
  isNew = false,
  recyclingKey,
  dimmed = false,
  read = false,
  onPress,
  onLongPress,
  metaAccessory,
  footerAccessory,
  testID,
}) => {
  const displayTitle = titleEnglish || titleOriginal || '';

  const surface = (
    <Card
      variant="elevated"
      size="sm"
      className={
        CARDS_USE_GLASS
          // Under glass the margin, radius and clipping move out to the
          // unpadded wrapper below, and the opaque `bg-background-0` the
          // `elevated` variant paints has to be cleared — left in place it
          // covers the plate and cancels the effect. The `size` padding stays
          // on the Card, so the layout is unchanged.
          ? 'bg-transparent rounded-xl'
          : 'mb-3 overflow-hidden rounded-xl'
      }
    >
      {/* No fixed minHeight: the card wraps its content. It was 128, which
            left visible dead space under a short 2-line headline. The image
            column is `self-stretch` with an ABSOLUTELY positioned image, so it
            simply fills whatever height the content column resolves to — image
            cards keep their layout, they just get shorter too. */}
        <Box className="flex-row">
          {/* Image Section - 1/4 width (25%). Article image, else placeholder.
              The image is ABSOLUTELY positioned to fill the column so its intrinsic
              size never drives the row height — the content column (below) owns the
              height, and the image just fills whatever that resolves to. Otherwise
              a tall source image stretches the whole row. */}
          <Box className="w-1/4 self-stretch overflow-hidden">
            {imageUrl ? (
              <Image
                source={{ uri: imageUrl }}
                alt={displayTitle}
                className="absolute inset-0 w-full h-full"
                resizeMode="cover"
                recyclingKey={recyclingKey}
              />
            ) : (
              <ArticleImagePlaceholder />
            )}
          </Box>

          {/* Content Section - 3/4 width (75%), three stacked zones. */}
          <Box className="flex-1 flex-col px-3 py-2">
            {/* 1. Meta row: time + language (flag lives in the footer) + optional
                metaAccessory. */}
            <Box className="flex-row items-center" style={{ gap: 6 }}>
              <Box className="flex-1">
                <ArticleMetaRow
                  pubDate={pubDate}
                  languageCode={languageCode}
                  countryCode={countryCode}
                  variant="card"
                  isNew={isNew}
                  read={read}
                  showFlag={false}
                />
              </Box>
              {metaAccessory}
            </Box>

            {/* 2. Headline — clamped to 2 lines. `my-1` instead of
                `flex-1 justify-center`: with no minHeight there is no spare
                height to distribute, and flex-1 would have re-introduced it. */}
            <Box className="my-1">
              <TranslatableDynamic
                text={displayTitle}
                originalText={titleOriginal}
                originalLanguage={sourceLanguage}
                size="md"
                className="leading-5 font-medium"
                numberOfLines={2}
              />
            </Box>

            {/* 3. Footer: footerAccessory (left) · country flag + publisher (right).
                The source group is `flex-1 justify-end` rather than relying on
                `justify-between`, so it stays right-aligned even when there is no
                accessory (standalone rows, unscored suggestions). */}
            <Box className="flex-row items-center" style={{ gap: 6 }}>
              {footerAccessory ? <Box className="flex-shrink-0">{footerAccessory}</Box> : null}
              <HStack className="items-center flex-1 justify-end" space="xs" style={{ minWidth: 0 }}>
                <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                {publicationName ? (
                  <Text size="xs" className="text-typography-500 flex-shrink" numberOfLines={1}>
                    {publicationName}
                  </Text>
                ) : null}
              </HStack>
            </Box>
          </Box>
        </Box>
      </Card>
  );

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      style={dimmed ? { opacity: 0.75 } : undefined}
    >
      {CARDS_USE_GLASS ? (
        // The plate is an absolute fill, so it has to hang off this UNPADDED
        // box — the one owning the radius and `overflow-hidden`, which is also
        // what rounds the glass.
        <Box className={`mb-3 rounded-xl overflow-hidden ${GLASS_CARD_EDGE}`}>
          <CardGlassPlate />
          {surface}
        </Box>
      ) : (
        surface
      )}
    </Pressable>
  );
};

export const ArticleCompactCardBase = React.memo(ArticleCompactCardBaseImpl);

export default ArticleCompactCardBase;
