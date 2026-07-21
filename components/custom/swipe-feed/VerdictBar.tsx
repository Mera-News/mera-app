// VerdictBar — the PRIMARY interaction for the Feed deck: two round thumb icon
// buttons plus a Mera button, laid out thumb-up (green, LEFT) · Mera (CENTER) ·
// thumb-down (red, RIGHT). Tapping a thumb records a verdict WITHOUT advancing
// the deck and opens the feedback-tree overlay (owned by the screen). On a
// revisited (Back) card the thumbs reflect the stored verdict; tapping the OTHER
// thumb flips it (onVerdictChanged), and re-tapping the SELECTED thumb re-opens
// the overlay (onReopenTree).
//
// Hidden by the screen for sentinel / empty states.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import MeraLogo from '@/components/custom/MeraLogo';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const LIKE_COLOR = '#22C55E';
const DISLIKE_COLOR = '#EF4444';
// Both thumbs are white-outline variants: white border, transparent fill; the
// glyph keeps its verdict color (green up / red down).
const OUTLINE_COLOR = '#FFFFFF';
const BUTTON_SIZE = 52;
const ICON_SIZE = 24;
// MeraLogo's visible hexagon spans ~67% of its `size` box, so oversizing the
// glyph past the button diameter (clipped by the button's overflow-hidden) lets
// the hexagon read at ~70% of the button — balanced against the 24px thumbs.
const MERA_LOGO_SIZE = 54;

interface VerdictBarProps {
  /** The card's currently-stored verdict (null when undecided). */
  verdict: Verdict | null;
  /** A thumb was tapped on an undecided card — record a fresh verdict. */
  onVerdict: (verdict: Verdict) => void;
  /** The other thumb was tapped on a decided card — flip the verdict. */
  onVerdictChanged: (from: Verdict, to: Verdict) => void;
  /** The already-selected thumb was tapped again — re-open the tree overlay. */
  onReopenTree?: () => void;
  /** The Mera button was tapped. */
  onAskMera: () => void;
}

const VerdictBar: React.FC<VerdictBarProps> = ({
  verdict,
  onVerdict,
  onVerdictChanged,
  onReopenTree,
  onAskMera,
}) => {
  const { t } = useTranslation();

  const select = (next: Verdict) => {
    if (verdict === next) {
      onReopenTree?.(); // re-open the overlay for an already-decided thumb
      return;
    }
    if (verdict == null) onVerdict(next);
    else onVerdictChanged(verdict, next);
  };

  const renderThumb = (
    value: Verdict,
    color: string,
    icon: keyof typeof MaterialIcons.glyphMap,
    label: string,
  ) => {
    const selected = verdict === value;
    const dimmed = verdict != null && !selected;
    return (
      <Pressable
        onPress={() => select(value)}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={label}
        className="items-center justify-center rounded-full"
        style={{
          width: BUTTON_SIZE,
          height: BUTTON_SIZE,
          backgroundColor: selected ? color : 'transparent',
          borderWidth: 2,
          borderColor: OUTLINE_COLOR,
          opacity: dimmed ? 0.45 : 1,
        }}
      >
        <MaterialIcons name={icon} size={ICON_SIZE} color={selected ? '#FFFFFF' : color} />
      </Pressable>
    );
  };

  return (
    <HStack className="items-center justify-center" space="2xl">
      {renderThumb('like', LIKE_COLOR, 'thumb-up', t('swipeFeed.moreLikeThis'))}
      <Pressable
        onPress={onAskMera}
        accessibilityRole="button"
        accessibilityLabel={t('swipeFeed.askMera')}
        className="rounded-full items-center justify-center"
        style={{ width: BUTTON_SIZE, height: BUTTON_SIZE }}
      >
        <Box
          className="rounded-full items-center justify-center overflow-hidden"
          style={{
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            backgroundColor: 'rgba(231,138,83,0.15)',
          }}
        >
          <MeraLogo size={MERA_LOGO_SIZE} />
        </Box>
      </Pressable>
      {renderThumb('dislike', DISLIKE_COLOR, 'thumb-down', t('swipeFeed.lessLikeThis'))}
    </HStack>
  );
};

export default VerdictBar;
