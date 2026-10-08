// ONE empty-state layout for the Library pages (Saved, Checks, Visited, Stats),
// Stories and an empty interest section (F22). There were four
// layouts on one screen: different icon sizes and greys, a title on one and
// not the others, and a stray button on another.
//
// Colour comes from the theme tokens (useColors), in `style`.
//
// A page whose board names a tutorial hero (FinalMotion "Empty pages": Stories,
// the Feed, Sources, Facts) passes `animationId` and the hero loops above the
// message at 64pt instead of the icon. "Learn about..." is the one action
// style: a white outline pill.

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import LoopScene from '@/components/custom/for-you/LoopScene';
import { animationSourceFor } from '@/components/custom/tutorials/animation-registry';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { I18nManager, Pressable, View } from 'react-native';
import FeedShortcuts from '@/components/custom/feed/FeedShortcuts';
import { GlassPanel } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
import { useTranslation } from 'react-i18next';
import { useColors } from '@/lib/theme/tokens';

const HERO_SIZE = 64;

export interface ForYouEmptyStateProps {
  /** Drawn when there is no `animationId`. */
  readonly icon?: keyof typeof MaterialIcons.glyphMap;
  /** An outline glyph the icon font lacks (Fact checks' shield-check), drawn
   *  instead of `icon`. Its size and colour are the caller's. */
  readonly glyph?: React.ReactElement;
  /** A tutorial animation id (`tutorials/animation-registry`), looped above
   *  the message in place of the icon. */
  readonly animationId?: string;
  readonly title?: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly onPress: () => void; readonly testID: string };
  /** `compact` sits inside a section panel; the default fills a tab. */
  readonly compact?: boolean;
  readonly testID: string;
}

const ForYouEmptyState: React.FC<ForYouEmptyStateProps> = ({
  icon,
  glyph,
  animationId,
  title,
  body,
  action,
  compact = false,
  testID,
}) => {
  const c = useColors();
  return (
  <VStack
    testID={testID}
    className={compact ? 'items-center px-4 py-4' : 'items-center justify-center px-8 py-16'}
    space="sm"
  >
    {/* Decoration: hidden, or it surfaces as its own icon-font StaticText. */}
    {animationId ? (
      <LoopScene source={animationSourceFor(animationId)} size={HERO_SIZE} testID={`${testID}-hero`} />
    ) : glyph ? (
      <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {glyph}
      </View>
    ) : icon ? (
      <MaterialIcons name={icon} size={compact ? 28 : 48} color={c.ink2} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
    ) : null}
    {title ? (
      <Text size="lg" className="text-center font-semibold" style={{ color: c.ink }}>
        {title}
      </Text>
    ) : null}
    <Text size="sm" className="text-center" style={{ color: c.ink }}>
      {body}
    </Text>
    {action ? (
      <Button
        variant="outline"
        className="rounded-full mt-2"
        style={{ borderColor: c.ink }}
        onPress={action.onPress}
        testID={action.testID}
      >
        <ButtonText style={{ color: c.ink }}>{action.label}</ButtonText>
      </Button>
    ) : null}
  </VStack>
  );
};

/**
 * The Feed's "No facts yet" block (FinalFeed #8, #9), both views: a COMPACT
 * card the size of the counts card (owner): the Mera mark, the title, the
 * instruction (it WRAPS, never truncates: it is the point of the card) and a
 * text link to the tutorial on adding facts ("Your facts shape your feed").
 * Under it the same shortcuts as the nothing-new Feed (World, the reader's
 * country when there is one, Saved and Stories by their own rules), with no
 * "While Mera reads" header: nothing is processing. Continuous keeps the top
 * headlines under it (OWNER_QUESTIONS C4); Sectioned shows it alone.
 */
export const FeedNoFacts: React.FC<{ readonly view: 'continuous' | 'sectioned' }> = ({ view }) => {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <View style={{ gap: 12 }} testID={`feed-no-facts-${view}`}>
      <GlassPanel radius={12} contentClassName="px-4 py-3">
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ paddingTop: 1 }}>
            <MeraLogo size={20} color={c.accentMark} animated={false} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={{ color: c.ink, fontSize: 15, lineHeight: 20, fontWeight: '600' }} accessibilityRole="header">
              {t('interests.emptyTitle')}
            </Text>
            <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 18 }}>{t('feed.noFactsBody')}</Text>
            <Pressable
              onPress={() => openTutorial('facts', 'a-fact-is')}
              accessibilityRole="link"
              accessibilityLabel={t('interests.learnAbout')}
              testID="feed-no-facts-learn"
              style={{ minHeight: 44, marginVertical: -10, justifyContent: 'center', alignSelf: 'flex-start' }}
            >
              <Text style={{ color: c.accentText, fontSize: 14, lineHeight: 19, fontWeight: '600' }}>
                {t('interests.learnAbout')} {I18nManager.isRTL ? '‹' : '›'}
              </Text>
            </Pressable>
          </View>
        </View>
      </GlassPanel>
      <FeedShortcuts reading={false} />
    </View>
  );
};

export default ForYouEmptyState;
