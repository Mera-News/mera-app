import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
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
 *   3. footer    — country flag + publisher name (left) · `footerAccessory` (right)
 * ].
 *
 * • `metaAccessory`   — small adornment at the right of the meta row (e.g. the
 *                       __DEV__ cluster-confidence chip).
 * • `footerAccessory` — a control at the far right of the footer row (e.g. the
 *                       RelevanceChip, or the "…" actions button). Absent ⇒ the
 *                       footer is just the source identity.
 */
const PLACEHOLDER = require('@/assets/images/news_card_placeholder_image.jpg');

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
  /** Marks the row as already-read — shows a small eye icon in the meta row
   *  next to the time group, instead of dimming. The Dashboard surfaces use
   *  this. */
  read?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  metaAccessory?: React.ReactNode;
  footerAccessory?: React.ReactNode;
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
}) => {
  const displayTitle = titleEnglish || titleOriginal || '';

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={dimmed ? { opacity: 0.75 } : undefined}>
      <Card variant="elevated" size="sm" className="mb-3 overflow-hidden rounded-xl">
        <Box className="flex-row" style={{ minHeight: 128 }}>
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
              <Image
                source={PLACEHOLDER}
                alt="News placeholder"
                className="absolute inset-0 w-full h-full"
                resizeMode="cover"
              />
            )}
          </Box>

          {/* Content Section - 3/4 width (75%), three stacked zones. */}
          <Box className="flex-1 flex-col px-3 py-3">
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

            {/* 2. Headline - takes the remaining height, up to 3 lines */}
            <Box className="flex-1 justify-center">
              <TranslatableDynamic
                text={displayTitle}
                originalText={titleOriginal}
                originalLanguage={sourceLanguage}
                size="md"
                className="leading-5 font-medium"
                numberOfLines={3}
              />
            </Box>

            {/* 3. Footer: country flag + publisher (left) · footerAccessory (right) */}
            <Box className="flex-row items-center justify-between" style={{ gap: 6 }}>
              <HStack className="items-center flex-shrink" space="xs" style={{ minWidth: 0 }}>
                <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                {publicationName ? (
                  <Text size="xs" className="text-typography-500 flex-shrink" numberOfLines={1}>
                    {publicationName}
                  </Text>
                ) : null}
              </HStack>
              {footerAccessory ? <Box className="flex-shrink-0">{footerAccessory}</Box> : null}
            </Box>
          </Box>
        </Box>
      </Card>
    </Pressable>
  );
};

export const ArticleCompactCardBase = React.memo(ArticleCompactCardBaseImpl);

export default ArticleCompactCardBase;
