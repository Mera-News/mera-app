// ArticleContextCard — the PINNED subject card at the top of an
// article-suggestion chat thread (Round-4 P4 handoff). Compact: a thumbnail
// (resolved from the suggestion row when available) + the article title, so the
// conversation always shows what it's about. Non-pressable — purely contextual.

import { ArticleImagePlaceholder } from '@/components/custom/cards/ArticleImagePlaceholder';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSuggestionByServerId } from '@/lib/database/services/article-suggestion-service';
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = '#EDA77E';

export interface ArticleContextCardProps {
  title: string;
  articleId?: string;
  suggestionId?: string;
}

const ArticleContextCard: React.FC<ArticleContextCardProps> = ({ title, suggestionId }) => {
  const { t } = useTranslation();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const blurImages = useBlurImagesStore((s) => s.blurImages);

  // Resolve a thumbnail from the on-device suggestion row (best-effort — degrade
  // to a title-only card when the row is gone / has no image).
  useEffect(() => {
    if (!suggestionId) return;
    let cancelled = false;
    getSuggestionByServerId(suggestionId)
      .then((row) => {
        if (!cancelled && row?.image_url) setImageUrl(row.image_url);
      })
      .catch(() => {
        /* non-fatal — title-only */
      });
    return () => {
      cancelled = true;
    };
  }, [suggestionId]);

  const showImage = !!imageUrl && !imageFailed;

  return (
    <Box
      className="mx-3 mt-2 mb-1 rounded-2xl overflow-hidden"
      style={{ backgroundColor: '#1a1a1a', borderColor: '#2e2e2e', borderWidth: 1 }}
    >
      <HStack className="items-center p-2.5" space="md">
        {showImage ? (
          <Box className="rounded-xl overflow-hidden" style={{ width: 52, height: 52 }}>
            <Image
              source={{ uri: imageUrl! }}
              alt={title}
              className="w-full h-full"
              resizeMode="cover"
              onError={() => setImageFailed(true)}
              blurRadius={blurImages ? 24 : undefined}
            />
          </Box>
        ) : (
          // Was its own third fallback style (an accent-tinted box + a
          // MaterialIcons glyph) — unified onto the shared placeholder used by
          // every card surface (ArticleCardBase, ArticleCompactCardBase). Two
          // things made this an easy call rather than a "deliberately keep
          // it" case: (1) the placeholder is now a monochrome translucent
          // black wash + white glyph, which sits naturally on this card's own
          // hardcoded `#1a1a1a` surface — the old warm off-white version
          // would have clashed here, which is presumably why this card never
          // adopted it originally; (2) one fewer "no image" visual language
          // for a user to learn. `size={28}` (default is 40) — this thumbnail
          // is 52x52 versus the ~112-192px hero/compact-card image regions
          // the default was tuned for.
          <Box className="rounded-xl overflow-hidden" style={{ width: 52, height: 52 }}>
            <ArticleImagePlaceholder size={28} />
          </Box>
        )}
        <VStack className="flex-1" space="xs">
          <Text style={{ color: ACCENT, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>
            {t('floatingChat.aboutThisStory')}
          </Text>
          {/* Explicit light value, NOT a `typography-*` class. This card paints
              its own hardcoded dark surface (#1a1a1a) in every theme, so it needs
              a colour that is readable against THAT, not against the app
              background. `text-typography-0` resolves to rgb(23,23,23) under the
              inverted dark ramp — near-black glyphs on a near-black card, ~1.03:1
              contrast, i.e. invisible. Matches ChatThread's convention of
              explicit rgb() values on this surface. */}
          {/* The headline is RUNTIME content (title_en — English by this app's
              design), so i18next can never reach it: it goes through the same
              on-device translator the feed cards use. No `originalText` is
              plumbed into the chat context, so while a translation is pending
              — or whenever the translator is gated/blocked — this renders the
              English source, exactly as TranslatableDynamic documents. That
              also means no translate icon and no show-original toggle here,
              unlike a feed card, which does hold the original.
              `lineHeight` is explicit because TranslatableDynamic derives its
              own from the `size` TOKEN (md → 24), which would be wrong for the
              13px font this card sets in `style`. Caller style spreads last. */}
          <TranslatableDynamic
            text={title}
            style={{
              color: 'rgb(245, 245, 245)',
              fontSize: 13,
              fontWeight: '600',
              lineHeight: 18,
            }}
            numberOfLines={2}
          />
        </VStack>
      </HStack>
    </Box>
  );
};

export default ArticleContextCard;
