import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import React from 'react';

/**
 * ArticleCompactCardBase — the compact (h-24 row) card CHROME, extracted verbatim
 * from `CompactPublisherNewsCard`. Purely presentational: callers pass a flat
 * view-model plus slots.
 *
 * Layout (unchanged, pixel-identical to CompactPublisherNewsCard):
 *   Pressable → elevated Card → flex-row h-24 [ ¼-width image (with placeholder)
 *   | ¾-width content { meta row (+ metaAccessory + trailingAccessory), 3-line
 *   title } ].
 *
 * • `metaAccessory`     — small adornment at the right of the meta row (e.g. the
 *                         __DEV__ cluster-confidence chip).
 * • `trailingAccessory` — a trailing control at the far right of the meta row
 *                         (e.g. the "…" actions button). Absent ⇒ no column
 *                         added, so existing rows stay pixel-identical.
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
  isNew?: boolean;
  recyclingKey?: string;
  /** Dims the whole row (~0.55 opacity) — used to fade already-opened rows in
   *  the Earlier zone. No visual change when undefined. */
  dimmed?: boolean;
  /** Marks the row as already-read — shows a small eye icon in the meta row
   *  next to the time group, instead of dimming. The Dashboard surfaces use
   *  this. */
  read?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  metaAccessory?: React.ReactNode;
  trailingAccessory?: React.ReactNode;
}

const ArticleCompactCardBaseImpl: React.FC<ArticleCompactCardBaseProps> = ({
  imageUrl,
  titleEnglish,
  titleOriginal,
  sourceLanguage,
  pubDate,
  languageCode,
  countryCode,
  isNew = false,
  recyclingKey,
  dimmed = false,
  read = false,
  onPress,
  onLongPress,
  metaAccessory,
  trailingAccessory,
}) => {
  const displayTitle = titleEnglish || titleOriginal || '';

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={dimmed ? { opacity: 0.75 } : undefined}>
      <Card variant="elevated" size="sm" className="mb-3 overflow-hidden rounded-xl">
        <Box className="flex-row h-24">
          {/* Image Section - 1/4 width (25%) */}
          <Box className="w-1/4 h-full">
            {imageUrl ? (
              <Image
                source={{ uri: imageUrl }}
                alt={displayTitle}
                className="w-full h-full"
                resizeMode="cover"
                recyclingKey={recyclingKey}
              />
            ) : (
              <Image
                source={PLACEHOLDER}
                alt="News placeholder"
                className="w-full h-full"
                resizeMode="cover"
              />
            )}
          </Box>

          {/* Content Section - 3/4 width (75%) */}
          <Box className="flex-1 flex-col px-3 py-2">
            {/* Top Row: 4-item meta row + optional metaAccessory + trailingAccessory */}
            <Box className="h-1/4 flex-row items-center" style={{ gap: 6 }}>
              <Box className="flex-1">
                <ArticleMetaRow
                  pubDate={pubDate}
                  languageCode={languageCode}
                  countryCode={countryCode}
                  variant="card"
                  isNew={isNew}
                  read={read}
                />
              </Box>
              {metaAccessory}
              {trailingAccessory}
            </Box>

            {/* Headline - 3/4 height */}
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
          </Box>
        </Box>
      </Card>
    </Pressable>
  );
};

export const ArticleCompactCardBase = React.memo(ArticleCompactCardBaseImpl);

export default ArticleCompactCardBase;
