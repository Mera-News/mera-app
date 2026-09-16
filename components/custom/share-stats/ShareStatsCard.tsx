// ShareStatsCard — picks one of the three cards and hands it the ref.
//
// A dispatcher rather than a card, and it keeps this module's public surface
// (`EXPORT_WIDTH`, `EXPORT_HEIGHT`, `hostSizeForScale`, `SAFE_RESERVE_PX`,
// `TOP_INK_FLOOR_PX`) so the preview screen, the capture path and the locale
// budget keep importing from one place while the card bodies live in
// `stats-cards.tsx` and the shared frame in `card-shell.tsx`.
//
// The ref is forwarded to whichever card renders, because that ref IS the
// capture host: `captureRef` snapshots the node it points at, so a dispatcher
// that dropped it would rasterise nothing.
//
// See `card-shell.tsx` for the export-size rule, both Instagram reserves and
// the fontSize/lineHeight rule, and `card-theme.ts` for why colour never comes
// from a palette class here.

import {
  KeepCard,
  LanguagesCard,
  PaceCard,
  ReachCard,
  RhythmCard,
  type StatsCardProps,
} from '@/components/custom/share-stats/stats-cards';
import { DEFAULT_STATS_CARD, type StatsCardId } from '@/lib/stats/reading-stats';
import React from 'react';
import { View } from 'react-native';

export {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  INK_BOX_ASPECT,
  INK_BOX_HEIGHT_PX,
  LOGO_TOP_MARGIN_PX,
  SAFE_RESERVE_PX,
  SHELL_METRICS,
  fitCardToPage,
  hostSizeForScale,
} from '@/components/custom/share-stats/card-shell';

export interface ShareStatsCardProps extends StatsCardProps {
  /** Which card to draw. Defaults to the one the shipped no-param deep link
   *  has always landed on. */
  card?: StatsCardId;
}

const BY_ID = {
  reach: ReachCard,
  languages: LanguagesCard,
  keep: KeepCard,
  pace: PaceCard,
  rhythm: RhythmCard,
} as const satisfies Record<StatsCardId, React.ComponentType<StatsCardProps & { ref?: React.Ref<View> }>>;

const ShareStatsCard = React.forwardRef<View, ShareStatsCardProps>(function ShareStatsCard(
  { card = DEFAULT_STATS_CARD, ...props },
  ref,
) {
  // `satisfies Record<StatsCardId, ...>` above means adding an id to the union
  // without adding it here is a TYPE error rather than an undefined component
  // at runtime.
  const Card = BY_ID[card] ?? BY_ID[DEFAULT_STATS_CARD];
  return <Card ref={ref} {...props} />;
});

export default ShareStatsCard;
