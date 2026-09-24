// The fact feed's closing row (N13): the way to the NEXT section, drawn in that
// section's own gradient so it reads as the next section arriving, or "Back to
// Dashboard" on the last one.
//
// ## Contrast is guaranteed by construction, not by luck of the hue
//
// A section's pastel sits at 0.30 over whatever is behind it, and behind this
// row is the animated backdrop, which can be bright. So the panel carries the
// over-content dark base FIRST and the gradient on top, and every line of text
// is white. `next-section-footer.test.ts` checks all 360 hues over a white
// backdrop and requires 4.5:1.
//
// The morph from footer into header is deferred; this row plus the screen's
// crossfade is the shipped version.

import SectionGradientPanel from '@/components/custom/for-you/SectionGradientPanel';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { GLASS_OVER_CONTENT_FILL } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export const NEXT_FOOTER_INK = '#FFFFFF';

export type NextSectionFooterProps =
  | {
      readonly kind: 'next';
      readonly factId: string;
      readonly title: string;
      /** Stories in the next section. 0 for an empty interest section, which
       *  then shows no count at all (never "0"). */
      readonly count: number;
      /** Headline section titles are app copy; fact titles are user data and
       *  go through the translator. */
      readonly translateTitle: boolean;
      readonly onPress: () => void;
    }
  | { readonly kind: 'back'; readonly onPress: () => void };

const NextSectionFooter: React.FC<NextSectionFooterProps> = (props) => {
  const { t } = useTranslation();

  if (props.kind === 'back') {
    return (
      <Pressable
        testID="fact-feed-back-to-dashboard"
        onPress={props.onPress}
        accessibilityRole="button"
        accessibilityLabel={t('forYou.backToDashboard')}
        className="items-center py-6 px-4"
      >
        <HStack className="items-center" space="xs">
          <MaterialIcons name="arrow-back" size={18} color={NEXT_FOOTER_INK} />
          <Text size="md" className="font-semibold" style={{ color: NEXT_FOOTER_INK }}>
            {t('forYou.backToDashboard')}
          </Text>
        </HStack>
      </Pressable>
    );
  }

  const { factId, title, count, translateTitle, onPress } = props;
  const countText = count > 0 ? t('trackedStories.articleCount', { count }) : null;
  const label = t('forYou.nextSection', { title });
  return (
    <Pressable
      testID="fact-feed-next"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={countText ? `${label} · ${countText}` : label}
      className="mx-1 mt-4 mb-2"
    >
      <SectionGradientPanel factId={factId} style={{ backgroundColor: GLASS_OVER_CONTENT_FILL }}>
        <HStack className="items-center px-4 py-4" space="md">
          <VStack className="flex-1 min-w-0">
            <Text size="xs" className="font-semibold" style={{ color: NEXT_FOOTER_INK }}>
              {t('forYou.nextSection', { title: '' }).trim()}
            </Text>
            {translateTitle ? (
              <TranslatableDynamic
                text={title}
                as="text"
                size="lg"
                bold
                numberOfLines={2}
                style={{ color: NEXT_FOOTER_INK }}
              />
            ) : (
              <Text size="lg" bold numberOfLines={2} style={{ color: NEXT_FOOTER_INK }}>
                {title}
              </Text>
            )}
            {countText ? (
              <Text size="xs" style={{ color: NEXT_FOOTER_INK }} testID="fact-feed-next-count">
                {countText}
              </Text>
            ) : null}
          </VStack>
          <MaterialIcons name="arrow-forward" size={22} color={NEXT_FOOTER_INK} />
        </HStack>
      </SectionGradientPanel>
    </Pressable>
  );
};

export default NextSectionFooter;
