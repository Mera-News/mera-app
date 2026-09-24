// The priority chip's SPOKEN text ("Medium priority"), apart from the chip so
// a card can read it in its own explicit label without importing the chip
// (card suites mock the chip module). One source for both.

import { bandOf } from '@/lib/news-harness/feed-select/ownership';
import type { TFunction } from 'i18next';

const SPOKEN_LABEL: Partial<Record<ReturnType<typeof bandOf>, 'relevance.a11yEmergency' | 'relevance.a11yHigh' | 'relevance.a11yMedium' | 'relevance.a11yLow'>> = {
    EMERGENCY: 'relevance.a11yEmergency',
    HIGH: 'relevance.a11yHigh',
    MEDIUM: 'relevance.a11yMedium',
    LOW: 'relevance.a11yLow',
};

export function relevanceSpokenLabel(t: TFunction, relevance: number): string {
    return t(SPOKEN_LABEL[bandOf(relevance)] ?? 'relevance.a11yLow');
}
