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
  onPress?: () => void;
  children?: React.ReactNode;
  metaAccessory?: React.ReactNode;
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
  onPress,
  children,
  metaAccessory,
}) => {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);

  const displayTitle = titleEnglish || t('feed.newsCluster');
  const showImage = !!imageUrl && !imageFailed;

  return (
    <Pressable onPress={onPress} style={dimmed ? { opacity: 0.75 } : undefined}>
      <Card variant="elevated" size="md" className="mb-4 overflow-hidden">
        {showImage && (
          <Box className="w-full h-48 overflow-hidden rounded-t-lg">
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
        <VStack className="p-4" space="sm">
          <Box>
            <ArticleMetaRow
              pubDate={pubDate}
              languageCode={languageCode}
              publicationName={publicationName}
              countryCode={countryCode}
              variant="card"
              isNew={isNew}
              moreSourcesCount={moreSourcesCount}
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
      </Card>
    </Pressable>
  );
};

// Memoized (default shallow compare): with a stable onPress + flat view-model
// props, a row bails out of re-rendering when nothing it displays changed —
// mirrors the old ArticleSuggestionContainer.memo contract (perf A2).
export const ArticleCardBase = React.memo(ArticleCardBaseImpl);

export default ArticleCardBase;
