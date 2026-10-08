// The Feed's card row skeleton (owner: "these cards should all look
// identical"): [icon slot][text column][chevron slot] with ONE set of
// paddings and widths. The shortcut rows (FeedShortcuts) and the counts
// card's lead row (DashboardStatsCard) both draw through it, inside a card
// with a 1pt edge, so their text, icon centre and chevron line up and
// cannot drift apart.
//
// A visual only: the caller lays a childless labelled Pressable over it (the
// glyph-leak pattern), so it renders hidden from accessibility.

import React from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

/** The card's corner radius (the shortcut cards'). */
export const CARD_RADIUS = 16;
/** The row's padding on every side, inside the card's 1pt edge. */
export const CARD_ROW_PAD = 12;
/** Between the slots and the text column. */
export const CARD_ROW_GAP = 12;
/** The icon slot (the shortcut's 40pt tile). */
export const CARD_ICON_SLOT = 40;
/** The chevron slot (a 22pt glyph). */
export const CARD_CHEVRON = 22;

const HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

export interface CardRowProps {
  /** Centred in the 40pt slot; may be larger and overflow it (never clipped). */
  readonly icon: React.ReactNode;
  /** The text column (flex 1). */
  readonly children: React.ReactNode;
  /** Centred in the 22pt slot. */
  readonly chevron: React.ReactNode;
  readonly onTextLayout?: (e: LayoutChangeEvent) => void;
}

const CardRow: React.FC<CardRowProps> = ({ icon, children, chevron, onTextLayout }) => (
  <View style={styles.row} pointerEvents="none" {...HIDDEN}>
    <View style={styles.icon}>{icon}</View>
    <View style={styles.texts} onLayout={onTextLayout}>
      {children}
    </View>
    <View style={styles.chevron}>{chevron}</View>
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: CARD_ROW_GAP, padding: CARD_ROW_PAD },
  icon: {
    width: CARD_ICON_SLOT,
    height: CARD_ICON_SLOT,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  texts: { flex: 1, minWidth: 0, gap: 2 },
  chevron: { width: CARD_CHEVRON, alignItems: 'center', justifyContent: 'center' },
});

export default CardRow;
