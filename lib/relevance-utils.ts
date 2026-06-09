export interface RelevanceColors {
    backgroundColor: string;
    borderColor: string;
    textColor: string;
    label: string;
}

// Shared reason box styling - lighter grey background with bold white text
export const reasonBoxColors = {
    backgroundColor: '#374151', // Lighter grey than card background
    textColor: '#FFFFFF'
};

export const getRelevanceLabel = (relevance: number): string => {
    if (relevance > 1.0) return 'Emergency Priority Articles';
    if (relevance >= 0.77) return 'High Priority Articles';
    if (relevance >= 0.53) return 'Medium Priority Articles';
    if (relevance > 0.3) return 'Low Priority Articles';
    return 'Irrelevant Articles';
};

const DISPLAY_SECTION_LABELS: Record<string, string> = {
    'Emergency Priority Articles': 'feed.sections.emergency',
    'High Priority Articles': 'feed.sections.majorImpact',
    'Medium Priority Articles': 'feed.sections.notableImpact',
    'Low Priority Articles': 'feed.sections.goodToKnow',
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
