import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import {
  CARDS_USE_GLASS,
  CardGlassPlate,
  GLASS_CARD_EDGE,
} from '@/components/custom/cards/CardGlassPlate';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import PressableCard from '@/components/custom/cards/PressableCard';
import { composeSpokenLabel, useArticleMetaStrings } from '@/components/custom/article-meta-strings';
import { Text } from '@/components/ui/text';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import { useAdaptiveLineClamp } from '@/lib/typography/useAdaptiveLineClamp';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable as RNPressable } from 'react-native';
import { Ellipsis } from 'lucide-react-native';
import type { AccessibilityActionEvent } from 'react-native';
import { useUpgradedImageSource } from '@/lib/images/use-upgraded-image-source';
import { COMPACT_TARGET_PX } from '@/lib/images/upgrade-image-url';

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
 *                                 footer line: publisher left, the ••• menu
 *                                 button right, stopping where the image
 *                                 starts
 *                    image        COMPACT_IMAGE_SIZE, only when there is one
 *
 * There is NO inline action row (owner review: it polluted the lists); the
 * menu carries like / not for me / save / share on compact rows. The country
 * flag sits in the meta row, immediately left of the language.
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

/** The ••• button: a 44pt frame around a 16pt glyph, pulled back into the
 *  21pt footer line by negative margins so the line (and the image arithmetic)
 *  keep their height; the glyph lands at the column's right edge. */
const MORE_BUTTON_STYLE = {
  minWidth: 44,
  minHeight: 44,
  marginVertical: -(44 - FOOTER_LINE_BOX) / 2,
  marginRight: -14,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
const MORE_GLYPH_COLOR = 'rgb(156, 163, 175)';

/** The loading tile behind a compact image (F39). */
export const COMPACT_IMAGE_TILE = 'rgba(255,255,255,0.06)';

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
  // NOTE: there is deliberately NO `onOpenArticle` button here. A compact row
  // once carried an external-link button that opened the publisher URL
  // directly, with no translate route beside it, stranding a reader whose
  // language differs from the article's. Opening the publisher from a row now
  // goes through the ••• menu, which offers "Open in Google Translate" next to
  // "Open on <source>" for a foreign-language article. Do not re-add a bare
  // direct-open button.
  metaAccessory?: React.ReactNode;
  priorityAccessory?: React.ReactNode;
  /** Optional testID passthrough for the card's root Pressable — used by
   *  concrete card components to expose a stable, driver-targetable id
   *  (e.g. `card-${articleId}`). No visual/behavioral effect. */
  testID?: string;
  /** Opens the row's ••• menu; the button sits at the right end of the
   *  publisher line. Absent: no button. */
  onOverflow?: () => void;
  /** VoiceOver custom actions on the row root (see `useArticleMenu`). The root
   *  Pressable is ONE accessibility element, so the ••• button is only
   *  reachable with VoiceOver through these. */
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (e: AccessibilityActionEvent) => void;
  /** The row's spoken priority (the chip's own label), read between the age
   *  and the language in the root's explicit label. */
  spokenPriority?: string | null;
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
  onOverflow,
  accessibilityActions,
  onAccessibilityAction,
  spokenPriority,
}) => {
  const { t } = useTranslation();
  const moreLabel = t('articleMenu.openA11y');
  const displayTitle = titleEnglish || titleOriginal || '';
  // The headline as displayed, and the row root's EXPLICIT label: without one
  // VoiceOver read the row's text run together, icon glyphs included
  // (", 12h ago, Medium priority"). Reuses the strings the row shows, in the
  // order it is read: headline, publication, age, priority, language.
  const [shownTitle, setShownTitle] = React.useState<string | null>(null);
  const meta = useArticleMetaStrings(pubDate, languageCode, publicationName);
  const spokenLabel = composeSpokenLabel([
    shownTitle ?? displayTitle,
    meta.publication,
    meta.age,
    spokenPriority,
    meta.language,
  ]);
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
  // Two-step fallback: rewritten URL -> original -> no column. The compact
  // target is small, so only the PARAMETERISED rules apply here; the binary
  // rules (which jump to the full original with no size control) are skipped
  // inside the hook, because a multi-megapixel original to fill 92pt is a
  // bandwidth regression, not an upgrade.
  //
  // Failure still resolves to "no image column", NOT to the placeholder: see
  // the note above. What the hook adds is a retry on the ORIGINAL before we get
  // there, so a rewrite that 404s no longer costs the row its picture.
  const rowImage = useUpgradedImageSource(imageUrl, COMPACT_TARGET_PX, {
    enabled: !blurImages,
  });
  const showImage = !!imageUrl && !rowImage.failed;

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
          {/* 1. Meta row — the FULL card width: time · priority · flag and
              language (the flag sits immediately left of the language). */}
          <Box className="flex-row items-center" style={{ gap: 6 }}>
            <Box className="flex-1">
              <ArticleMetaRow
                pubDate={pubDate}
                languageCode={languageCode}
                variant="card"
                isNew={isNew}
                read={read}
                countryCode={countryCode}
                showFlag
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
              {/* Headline takes the slack and centres inside it, so a short
                  headline sits between the meta row and the footer rather than
                  pinned under the meta row.

                  `flexGrow` ALONE, never `flex-1`. `flex: 1` also sets
                  `flexBasis: 0`, and this box sits in a COLUMN whose height is
                  auto whenever there is no image to force one. A zero basis
                  then contributes zero to that auto height, so the headline
                  collapsed to nothing and imageless rows rendered a time, a
                  language and a publisher with a blank space where the story
                  was. With the basis left at `auto` the box is content-sized
                  when there is nothing to grow into, and grows to fill the
                  image's height when there is. */}
              <Box className="justify-center" style={{ flexGrow: 1 }}>
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
                  onDisplayChange={(d) => setShownTitle(d.displayedText)}
                />
              </Box>

              {/* Footer line: publisher left, ••• right. Inside the left column,
                  so it ends where the image starts, level with the image's
                  bottom edge. Its HEIGHT is pinned to FOOTER_LINE_BOX because
                  COMPACT_IMAGE_SIZE is measured against it; the ••• keeps a
                  44pt frame through negative vertical margins, so the target
                  grows without the line growing. `marginTop` is inline rather
                  than `mt-3`; see the note on FOOTER_GAP. */}
              <HStack
                className="items-center justify-between"
                space="xs"
                style={{ marginTop: FOOTER_GAP, minWidth: 0, height: FOOTER_LINE_BOX }}
                testID="compact-card-footer"
              >
                {publicationName ? (
                  <Text
                    size="xs"
                    className="text-typography-500"
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ flexShrink: 1 }}
                  >
                    {publicationName}
                  </Text>
                ) : (
                  <Box />
                )}
                {onOverflow ? (
                  <RNPressable
                    testID="compact-card-more"
                    onPress={onOverflow}
                    accessibilityRole="button"
                    accessibilityLabel={moreLabel}
                    // STATIC style (a function style is dropped on device).
                    style={MORE_BUTTON_STYLE}
                  >
                    <Ellipsis size={16} strokeWidth={2} color={MORE_GLYPH_COLOR} />
                  </RNPressable>
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
                  // F39: a quiet tile holds the square while the image
                  // decodes, instead of the picture popping into a blank hole.
                  backgroundColor: COMPACT_IMAGE_TILE,
                }}
              >
                <Image
                  source={{ uri: rowImage.uri! }}
                  alt={displayTitle}
                  className="w-full h-full"
                  resizeMode="cover"
                  recyclingKey={recyclingKey}
                  onError={rowImage.onError}
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
    <PressableCard
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      dimmed={!!dimmed}
      accessibilityLabel={spokenLabel}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
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
    </PressableCard>
  );
};

export const ArticleCompactCardBase = React.memo(ArticleCompactCardBaseImpl);

export default ArticleCompactCardBase;
