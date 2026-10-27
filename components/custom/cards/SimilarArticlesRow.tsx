import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { Layers } from 'lucide-react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ROW_HEIGHT = 18;

/**
 * "N similar articles": the line a card shows when other publishers carry the
 * same story (copies grouped by story key). Right-aligned, inside the card's
 * own surface, no divider, and not a tap target: the card itself opens. The
 * stack glyph is decorative, so it is hidden from VoiceOver; the card root's
 * spoken label carries the count instead.
 *
 * `count` 0 keeps the row's height with the label hidden: a Feed card that
 * showed the row earlier this session must not shrink under the reader when a
 * member leaves the pool.
 */
export const SimilarArticlesRow: React.FC<{ count: number; testID?: string }> = ({
  count,
  testID = 'card-similar-articles',
}) => {
  const { t } = useTranslation();
  const colors = useColors();
  const shown = count >= 1;
  return (
    <Box testID={testID} style={{ height: ROW_HEIGHT }} className="w-full items-end justify-center">
      <HStack
        space="xs"
        className="items-center"
        style={{ opacity: shown ? 1 : 0 }}
        accessibilityElementsHidden={!shown}
        importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      >
        <Box
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Layers size={14} strokeWidth={2} color={colors.ink3} />
        </Box>
        <Text size="xs" className="font-medium text-ink-3">
          {t('feed.similarArticles', { count: Math.max(1, count) })}
        </Text>
      </HStack>
    </Box>
  );
};

export default SimilarArticlesRow;
