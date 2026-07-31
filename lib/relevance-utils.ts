export interface RelevanceColors {
    backgroundColor: string;
    borderColor: string;
    textColor: string;
    label: string;
}

// Shared reason box styling - lighter grey background with bold white text
export const reasonBoxColors = {
    // A neutral DARKENING, not a tint. This box sits on a translucent card over
    // the animated gradient backdrop, and the old fill was #374151 — a blue-grey
    // with a hue of its own, which fought whatever colour the gradient happened
    // to be behind it and read as a pasted-on slab no matter how far the alpha
    // dropped. Plain black at 25% has no hue to clash: it darkens whatever is
    // behind it, so the gradient's colour still comes through, just deeper. That
    // is what makes it blend instead of sit on top.
    //
    // Still comfortably dark enough for the white `textColor` and for
    // `aiDisclosureColor` (#D1D5DB) over any palette entry.
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    textColor: '#FFFFFF'
};

/**
 * Colour for the AI-disclosure label rendered inside the reason box. Dimmer
 * than `reasonBoxColors.textColor` so the label stays subordinate to the note,
 * and comfortable against the box, which is now a 25% black darkening of the page
 * rather than the old solid `#374151`. The muted typography token the label uses
 * elsewhere does not clear 4.5:1 there.
 */
export const aiDisclosureColor = '#D1D5DB';

export const getRelevanceLabel = (relevance: number): string => {
    if (relevance > 1.0) return 'Emergency Priority Articles';
    if (relevance >= 0.77) return 'High Priority Articles';
    if (relevance >= 0.53) return 'Medium Priority Articles';
    if (relevance > 0.3) return 'Low Priority Articles';
    return 'Irrelevant Articles';
};

const DISPLAY_SECTION_LABELS: Record<string, string> = {
    'Emergency Priority Articles': 'feed.sections.emergency',
    'High Priority Articles': 'feed.sections.high',
    'Medium Priority Articles': 'feed.sections.medium',
    'Low Priority Articles': 'feed.sections.low',
    'Unscored Articles': 'feed.sections.unscoredShort',
};

export const getDisplaySectionLabel = (label: string): string =>
    DISPLAY_SECTION_LABELS[label] ?? label;

export const getRelevanceColors = (relevance: number): RelevanceColors => {
    if (relevance < 0) {
        return {
            backgroundColor: '#1F2937',
            borderColor: '#9CA3AF',
            textColor: '#9CA3AF',
            label: 'relevance.unprocessed'
        };
    }
    if (relevance > 1.0) {
        return {
            backgroundColor: '#F3E5F5',
            borderColor: '#6A1B9A',
            textColor: '#6A1B9A',
            label: 'relevance.emergency'
        };
    } else if (relevance >= 0.77) {
        return {
            backgroundColor: '#FFEBEE',
            borderColor: '#C62828',
            textColor: '#C62828',
            label: 'relevance.high'
        };
    } else if (relevance >= 0.53) {
        return {
            backgroundColor: '#FFF3E0',
            borderColor: '#E65100',
            textColor: '#E65100',
            label: 'relevance.medium'
        };
    } else if (relevance > 0.3) {
        return {
            backgroundColor: '#FFFDE7',
            borderColor: '#F57F17',
            textColor: '#F57F17',
            label: 'relevance.low'
        };
    } else {
        return {
            backgroundColor: '#F5F5F5',
            borderColor: '#616161',
            textColor: '#616161',
            label: 'relevance.irrelevant'
        };
    }
};
