// ONE empty-state layout for the Library pages (Saved, Checks, Visited, Stats),
// Stories and an empty interest section (F22). There were four
// layouts on one screen: different icon sizes and greys, a title on one and
// not the others, and a stray button on another.
//
// Colour is in `style`, never a typography class: the dark ramp is inverted
// and the old `text-typography-400` body was rgb 140.
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
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

export const EMPTY_STATE_INK = {
  title: '#FFFFFF',
  body: 'rgb(212, 212, 212)',
  icon: 'rgb(163, 163, 163)',
} as const;

const HERO_SIZE = 64;

export interface ForYouEmptyStateProps {
  /** Drawn when there is no `animationId`. */
  readonly icon?: keyof typeof MaterialIcons.glyphMap;
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
  animationId,
  title,
  body,
  action,
  compact = false,
  testID,
}) => (
  <VStack
    testID={testID}
    className={compact ? 'items-center px-4 py-4' : 'items-center justify-center px-8 py-16'}
    space="sm"
  >
    {/* Decoration: hidden, or it surfaces as its own icon-font StaticText. */}
    {animationId ? (
      <LoopScene source={animationSourceFor(animationId)} size={HERO_SIZE} testID={`${testID}-hero`} />
    ) : icon ? (
      <MaterialIcons name={icon} size={compact ? 28 : 48} color={EMPTY_STATE_INK.icon} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
    ) : null}
    {title ? (
      <Text size="lg" className="text-center font-semibold" style={{ color: EMPTY_STATE_INK.title }}>
        {title}
      </Text>
    ) : null}
    <Text size="sm" className="text-center" style={{ color: EMPTY_STATE_INK.body }}>
      {body}
    </Text>
    {action ? (
      <Button
        variant="outline"
        className="rounded-full mt-2"
        style={{ borderColor: EMPTY_STATE_INK.title }}
        onPress={action.onPress}
        testID={action.testID}
      >
        <ButtonText style={{ color: EMPTY_STATE_INK.title }}>{action.label}</ButtonText>
      </Button>
    ) : null}
  </VStack>
);

export default ForYouEmptyState;
