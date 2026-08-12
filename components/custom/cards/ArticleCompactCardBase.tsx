import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
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
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useAdaptiveLineClamp } from '@/lib/typography/useAdaptiveLineClamp';
import React, { useState } from 'react';

/**
 * ArticleCompactCardBase — the compact card CHROME. Purely presentational:
 * callers pass a flat view-model plus slots.
 *
 * Layout: Pressable → elevated Card → one column of three zones:
 *   1. meta row  — spans the full card width: time (left) + language (right),
 *                  which is just what ArticleMetaRow's `justify-between` does
 *                  when recency and language are its only populated slots.
 *                  `metaAccessory` trails it.
 *   2. body      — title (flex-1) beside a fixed 78x78 image square on the
 *                  RIGHT. No image ⇒ no image node at all, so the title runs
 *                  the full width.
 *   3. footer    — full width BELOW the image: `footerAccessory` (left) ·
 *                  country flag + publisher name (right)
 *
 * The image used to be a ¼-width column bleeding down the LEFT edge, holding
 * the Mera watermark when an article had none. The watermark is gone from this
 * card entirely (it survives only on the chat context card): an imageless row
 * is now just text.
 *
 * Faithful to the source design except for one thing Yoga cannot express. That
 * design floats the image right so the headline reflows UNDERNEATH it, and
 * clears the float at the footer. React Native has no float and cannot wrap
 * text around a block, so a long headline stops at the image's left edge. The
 * `clear` half IS reproduced: the footer is a full-width sibling below the
 * title/image row, not a third column beside them.
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
  // NOTE: there is deliberately NO `onOpenArticle` escape hatch here any more.
  // A compact row used to carry a small external-link button that opened the
  // publisher URL directly — which skipped the detail screen, and with it the
  // ONLY place the translate affordance lives (ReadTranslateActions). A reader
  // whose language differs from the article's was then stuck with an untranslated
  // page and no way back to the translate options. Compact rows navigate to a
  // detail screen via `onPress`; that screen owns opening the URL. Do not
  // re-add a direct-open path here.
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
  const blurImages = useBlurImagesStore((s) => s.blurImages);
  // 2 lines is 2 lines of WORDS at the default size and roughly one word at
  // 2x — the clamp has to move with the type or a large-text reader gets an
  // ellipsis where the headline was. Returns exactly 2 at 1x.
  const headlineLines = useAdaptiveLineClamp(2, 4);
  // Tracks LOADED, not merely PASSED IN. The guard was once
  // `imageUrl ? <Image/> : <Placeholder/>`, which never noticed a 404 or a
  // timeout and left a blank quarter-width hole. Now a failure collapses the
  // square away and the headline reflows to full width, so a broken image is
  // indistinguishable from no image — on every surface that renders this shared
  // chrome (saved suggestions, related articles, story timeline, publication
  // history, persona article list). ArticleCardBase does the same for the hero.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = !!imageUrl && !imageFailed;

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
            left visible dead space under a short 2-line headline. */}
        <Box className="flex-col">
          {/* 1. Meta row — the FULL card width. `countryCode` is deliberately
              not passed: this row's flag is off (`showFlag={false}`) because the
              footer draws it, so handing it a country here would only look
              live. Time lands left and language right by `justify-between`,
              those being the only two slots this card populates. */}
          <Box className="flex-row items-center" style={{ gap: 6 }}>
            <Box className="flex-1">
              <ArticleMetaRow
                pubDate={pubDate}
                languageCode={languageCode}
                variant="card"
                isNew={isNew}
                read={read}
                showFlag={false}
              />
            </Box>
            {metaAccessory}
          </Box>

          {/* 2. Body — headline beside the image square. `items-start` pins the
              image to the top of the row, under the language slot, rather than
              letting it centre against a taller headline. */}
          <Box className="flex-row items-start mt-2">
            <Box className="flex-1">
              <TranslatableDynamic
                text={displayTitle}
                originalText={titleOriginal}
                originalLanguage={sourceLanguage}
                size="md"
                // No ``: 20px on 16px type (1.25) is a Latin-sized
                // line box, and this is the most-translated text in the app —
                // Devanagari/Thai marks sit above it and get sliced. Dropping
                // the class lets the `md` token's own 24px line box apply.
                className="font-medium"
                numberOfLines={headlineLines}
              />
            </Box>
            {/* Fixed 78x78, so unlike the old `self-stretch` column it CAN drive
                the row height — an image row is taller than a text-only one,
                which is what the design shows. Absent entirely with no image:
                that is the whole point of this card, the headline then runs to
                the card's right edge. */}
            {showImage ? (
              <Box
                className="overflow-hidden"
                style={{ width: 78, height: 78, borderRadius: 13, marginLeft: 14 }}
              >
                <Image
                  source={{ uri: imageUrl! }}
                  alt={displayTitle}
                  className="w-full h-full"
                  resizeMode="cover"
                  recyclingKey={recyclingKey}
                  onError={() => setImageFailed(true)}
                  blurRadius={blurImages ? 24 : undefined}
                  // Decorative, and these arrive by the screenful — yield decode
                  // work to whatever the user is waiting on. See the longer note
                  // in ArticleCardBase.
                  priority="low"
                />
              </Box>
            ) : null}
          </Box>

          {/* 3. Footer: footerAccessory (left) · country flag + publisher (right).
              Full width, BELOW the image rather than beside it — the design's
              `clear:right`. The source group is `flex-1 justify-end` rather than
              relying on `justify-between`, so it stays right-aligned even when
              there is no accessory (standalone rows, unscored suggestions),
              which is most of them. */}
          <Box className="flex-row items-center mt-3" style={{ gap: 6 }}>
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
