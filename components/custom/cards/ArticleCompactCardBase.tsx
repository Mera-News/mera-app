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
 * Layout: Pressable → elevated Card →
 *   1. meta row  — spans the full card width: time (left) · `priorityAccessory`
 *                  (middle) · language (right). All three are slots of
 *                  ArticleMetaRow, whose `justify-between` does the spacing;
 *                  `metaAccessory` trails the row.
 *   2. body row  — a left column beside a square image anchored BOTTOM-RIGHT:
 *                    left column  headline (centred in its slack) over the
 *                                 footer (country flag + publisher), which
 *                                 stops where the image starts
 *                    image        COMPACT_IMAGE_SIZE, only when there is one
 *
 * The image used to be a ¼-width column bleeding down the LEFT edge, holding
 * the Mera watermark when an article had none. The watermark is gone from this
 * card entirely (it survives only on the chat context card): an imageless row
 * is now just text.
 *
 * Derived from the source design, with one thing Yoga cannot express: that
 * design floats the image right so the headline reflows UNDERNEATH it. React
 * Native has no float and cannot wrap text around a block, so a long headline
 * stops at the image's left edge.
 *
 * • `metaAccessory`     — small adornment at the right of the meta row (e.g.
 *                         the __DEV__ cluster-confidence chip).
 * • `priorityAccessory` — the middle slot of the meta row (the RelevanceChip).
 *                         It sat in the footer until the image grew into that
 *                         corner. Absent ⇒ the meta row is just time and
 *                         language, spaced apart as before.
 */

/**
 * The image is a square exactly as tall as the text beside it: three headline
 * lines, the gap, and the one-line footer. Its bottom edge therefore lands
 * flush with the publisher name.
 *
 * The arithmetic is spelled out rather than the answer written down because
 * `COMPACT_HEADLINE_LINES` is ALSO the clamp fed to `useAdaptiveLineClamp`
 * below. Written as a bare `105` the two could drift, and the failure is
 * invisible: the image would simply stop lining up with text that is now four
 * lines, or float above a footer that moved.
 *
 * Every term is whole px taken straight from `tailwind.config.js`'s fontSize
 * scale, which states px explicitly. `FOOTER_GAP` is applied as an inline style
 * for the same reason: `mt-3` is 0.75rem, NativeWind inlines rem at build time
 * with `inlineRem`, and tailwind.config.js:212 records that setting it to 16
 * was deliberately NOT done — so the class renders 10.5px, not 12, and the sum
 * would land on a fraction.
 */
export const COMPACT_HEADLINE_LINES = 3;
/** `fontSize.base` line box — the headline's `size="md"`. */
const HEADLINE_LINE_BOX = 24;
/** `fontSize.sm` line box. The flag emoji is `text-sm` and is the tallest thing
 *  in the footer; the publisher name is `text-xs` at 18. */
const FOOTER_LINE_BOX = 21;
const FOOTER_GAP = 12;

export const COMPACT_IMAGE_SIZE =
  COMPACT_HEADLINE_LINES * HEADLINE_LINE_BOX + FOOTER_GAP + FOOTER_LINE_BOX;

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
  priorityAccessory?: React.ReactNode;
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
  priorityAccessory,
  testID,
}) => {
  const displayTitle = titleEnglish || titleOriginal || '';
  const blurImages = useBlurImagesStore((s) => s.blurImages);
  // The same line count the image is sized against — see COMPACT_IMAGE_SIZE.
  // The clamp still has to grow with the type: a fixed clamp is a fixed number
  // of LINES, not a fixed amount of text, and at 2x three lines is barely a
  // phrase. Returns exactly COMPACT_HEADLINE_LINES at 1x.
  const headlineLines = useAdaptiveLineClamp(COMPACT_HEADLINE_LINES, 4);
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
              live. `justify-between` then spaces the three populated slots as
              time · priority · language. */}
          <Box className="flex-row items-center" style={{ gap: 6 }}>
            <Box className="flex-1">
              <ArticleMetaRow
                pubDate={pubDate}
                languageCode={languageCode}
                variant="card"
                isNew={isNew}
                read={read}
                showFlag={false}
                centerAccessory={priorityAccessory}
              />
            </Box>
            {metaAccessory}
          </Box>

          {/* 2. Body — a left column beside a square image anchored to the
              BOTTOM-RIGHT corner. Cross-axis alignment is the default
              `stretch`, deliberately: that is what lets the left column fill
              the image's height so it has slack of its own to distribute. */}
          <Box className="flex-row mt-2">
            <Box className="flex-1 flex-col">
              {/* Headline takes the slack (`flex-1`) and centres inside it, so
                  a short headline sits between the meta row and the footer
                  rather than pinned under the meta row. On an imageless row
                  there IS no slack — the row height is the content height — so
                  this is a no-op there and needs no guard. */}
              <Box className="flex-1 justify-center">
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

              {/* Footer: country flag + publisher. Inside the left column, so
                  it ends where the image starts rather than running the card
                  width, and it sits at the column's bottom edge — level with
                  the bottom of the image. `marginTop` is inline rather than
                  `mt-3` because COMPACT_IMAGE_SIZE is measured against it; see
                  the note on FOOTER_GAP. */}
              <HStack
                className="items-center"
                space="xs"
                style={{ marginTop: FOOTER_GAP, minWidth: 0 }}
              >
                <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                {publicationName ? (
                  <Text size="xs" className="text-typography-500 flex-shrink" numberOfLines={1}>
                    {publicationName}
                  </Text>
                ) : null}
              </HStack>
            </Box>

            {/* `self-end` is the anchor: the square hangs off the bottom of the
                row, so when the left column is TALLER (a 4-line headline at
                large text sizes) the image stays level with the publisher name
                instead of drifting up. Absent entirely with no image — that is
                the point of this card, the text then runs to the card's right
                edge. */}
            {showImage ? (
              <Box
                className="overflow-hidden self-end"
                style={{
                  width: COMPACT_IMAGE_SIZE,
                  height: COMPACT_IMAGE_SIZE,
                  borderRadius: 16,
                  marginLeft: 14,
                }}
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
