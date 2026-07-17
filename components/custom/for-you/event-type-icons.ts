import { MaterialIcons } from '@expo/vector-icons';

/**
 * Controlled `event_type` value → MaterialIcons glyph, per the plan's icon map
 * (icon-first directive, Wave 7c N2). Used to prefix fact-section headers and
 * cards. `other`/unknown values have no meaningful icon → null (render nothing).
 */
const EVENT_TYPE_ICON: Record<string, keyof typeof MaterialIcons.glyphMap> = {
  election: 'how-to-vote',
  weather: 'cloud',
  disaster: 'warning',
  sports: 'sports-soccer',
  business: 'trending-up',
  health: 'medical-services',
  crime: 'gavel',
  science_tech: 'science',
  // `entertainment` → theater-comedy; `conflict`/`politics`/`other` intentionally
  // have no icon (label-led).
  entertainment: 'theater-comedy',
};

export function eventTypeIcon(
  eventType: string | null | undefined,
): keyof typeof MaterialIcons.glyphMap | null {
  if (!eventType) return null;
  return EVENT_TYPE_ICON[eventType] ?? null;
}
