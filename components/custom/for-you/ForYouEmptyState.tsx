// ONE empty-state layout for the Dashboard's library tabs (Saved, Fact checks,
// Visited, Stories) and for an empty interest section (F22). There were four
// layouts on one screen: different icon sizes and greys, a title on one and
// not the others, and a stray button on another.
//
// Colour is in `style`, never a typography class: the dark ramp is inverted
// and the old `text-typography-400` body was rgb 140.

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

export const EMPTY_STATE_INK = {
  title: '#FFFFFF',
  body: 'rgb(212, 212, 212)',
  icon: 'rgb(163, 163, 163)',
} as const;

export interface ForYouEmptyStateProps {
  readonly icon: keyof typeof MaterialIcons.glyphMap;
  readonly title?: string;
  readonly body: string;
  readonly action?: { readonly label: string; readonly onPress: () => void; readonly testID: string };
  /** `compact` sits inside a section panel; the default fills a tab. */
  readonly compact?: boolean;
  readonly testID: string;
}

const ForYouEmptyState: React.FC<ForYouEmptyStateProps> = ({
  icon,
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
    <MaterialIcons name={icon} size={compact ? 28 : 48} color={EMPTY_STATE_INK.icon} />
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
        className="rounded-full border-primary-500 mt-2"
        onPress={action.onPress}
        testID={action.testID}
      >
        <ButtonText className="text-primary-400">{action.label}</ButtonText>
      </Button>
    ) : null}
  </VStack>
);

export default ForYouEmptyState;
