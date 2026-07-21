// VerdictBar — the PRIMARY interaction for the Feed deck: two labeled pills
// ("✕ Less like this" / "♥ More like this") plus a Mera button. Tapping a pill
// records a verdict WITHOUT advancing the deck (so the P4 inline-feedback tree
// can appear beneath it via `treeSlot`). On a revisited (Back) card the pills
// reflect the stored verdict; tapping the OTHER pill flips it (onVerdictChanged).
//
// Hidden by the screen for sentinel / empty states.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const LIKE_COLOR = '#22C55E';
const DISLIKE_COLOR = '#EF4444';

interface VerdictBarProps {
  /** The card's currently-stored verdict (null when undecided). */
  verdict: Verdict | null;
  /** A pill was tapped on an undecided card — record a fresh verdict. */
  onVerdict: (verdict: Verdict) => void;
  /** The other pill was tapped on a decided card — flip the verdict. */
  onVerdictChanged: (from: Verdict, to: Verdict) => void;
  /** The Mera button was tapped. */
  onAskMera: () => void;
  /** P4 injects the inline-feedback tree here; shown once a verdict exists. */
  treeSlot?: React.ReactNode;
}

const VerdictBar: React.FC<VerdictBarProps> = ({
  verdict,
  onVerdict,
  onVerdictChanged,
  onAskMera,
  treeSlot,
}) => {
  const { t } = useTranslation();

  const select = (next: Verdict) => {
    if (verdict === next) return; // already selected — no-op
    if (verdict == null) onVerdict(next);
    else onVerdictChanged(verdict, next);
  };

  const renderPill = (value: Verdict, color: string, icon: keyof typeof MaterialIcons.glyphMap, label: string) => {
    const selected = verdict === value;
    const dimmed = verdict != null && !selected;
    return (
      <Pressable
        onPress={() => select(value)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={label}
        className="flex-1 rounded-full py-3"
        style={{
          backgroundColor: selected ? color : 'transparent',
          borderWidth: 2,
          borderColor: color,
          opacity: dimmed ? 0.45 : 1,
        }}
      >
        <HStack className="items-center justify-center" space="xs">
          <MaterialIcons name={icon} size={18} color={selected ? '#FFFFFF' : color} />
          <Text size="sm" style={{ color: selected ? '#FFFFFF' : color, fontWeight: '700' }}>
            {label}
          </Text>
        </HStack>
      </Pressable>
    );
  };

  return (
    <VStack space="sm">
      <HStack className="items-center" space="sm">
        {renderPill('dislike', DISLIKE_COLOR, 'close', t('swipeFeed.lessLikeThis'))}
        {renderPill('like', LIKE_COLOR, 'favorite', t('swipeFeed.moreLikeThis'))}
        <Pressable
          onPress={onAskMera}
          accessibilityRole="button"
          accessibilityLabel={t('swipeFeed.askMera')}
          className="rounded-full items-center justify-center"
          style={{ width: 48, height: 48 }}
        >
          <Box className="rounded-full items-center justify-center" style={{ width: 48, height: 48, backgroundColor: 'rgba(231,138,83,0.15)' }}>
            <MeraLogo size={30} />
          </Box>
        </Pressable>
      </HStack>
      {verdict != null && treeSlot ? <Box>{treeSlot}</Box> : null}
    </VStack>
  );
};

export default VerdictBar;
