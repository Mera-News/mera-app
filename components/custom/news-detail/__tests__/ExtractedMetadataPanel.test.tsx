// ExtractedMetadataPanel — the transparency panel for the server's
// machine-extracted tags (places, entities, event type). Three properties
// pinned here because nothing else enforces them:
//   • toggle OFF renders nothing, regardless of how much data is present
//   • toggle ON but every field empty/absent renders nothing (absence is
//     normal, not an error state — never an empty box)
//   • `event_type` is humanized from its raw token (no per-value lookup)
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, opts?: Record<string, unknown>) =>
            opts ? `${key}::${JSON.stringify(opts)}` : key,
    }),
}));

const mockUseShowExtractedMetadata = jest.fn();
jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useShowExtractedMetadata: () => mockUseShowExtractedMetadata(),
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import ExtractedMetadataPanel from '../ExtractedMetadataPanel';

describe('ExtractedMetadataPanel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('renders nothing when the toggle is off, even with full data', () => {
        mockUseShowExtractedMetadata.mockReturnValue(false);
        const { queryByTestId } = render(
            <ExtractedMetadataPanel
                eventType="election"
                entities={['Congress', 'Senate']}
                geoTags={[{ city: 'Delhi', region: null, countryCode: 'IN' }]}
            />,
        );
        expect(queryByTestId('article-detail-extracted-metadata')).toBeNull();
    });

    it('renders nothing when the toggle is on but every field is empty', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { queryByTestId } = render(
            <ExtractedMetadataPanel eventType={null} entities={null} geoTags={null} />,
        );
        expect(queryByTestId('article-detail-extracted-metadata')).toBeNull();
    });

    it('renders nothing when the toggle is on and fields are present but empty arrays/blank strings', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { queryByTestId } = render(
            <ExtractedMetadataPanel
                eventType={null}
                entities={['', '   ']}
                geoTags={[{ city: null, region: null, countryCode: null }]}
            />,
        );
        expect(queryByTestId('article-detail-extracted-metadata')).toBeNull();
    });

    it('renders the panel with a humanized event type when only event_type is present', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { getByTestId, getByText } = render(
            <ExtractedMetadataPanel eventType="science_tech" entities={null} geoTags={null} />,
        );
        expect(getByTestId('article-detail-extracted-metadata')).toBeTruthy();
        expect(getByText('Science Tech')).toBeTruthy();
    });

    it('renders places joined from geo tags, filtering blank fields', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { getByText } = render(
            <ExtractedMetadataPanel
                eventType={null}
                entities={null}
                geoTags={[
                    { city: 'Pune', region: null, countryCode: 'IN' },
                    { city: null, region: 'Bavaria', countryCode: 'DE' },
                ]}
            />,
        );
        expect(getByText('Pune, IN · Bavaria, DE')).toBeTruthy();
    });

    it('renders entities joined and filters blank entries', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { getByText } = render(
            <ExtractedMetadataPanel
                eventType={null}
                entities={['NASA', '', 'ISRO', '   ']}
                geoTags={null}
            />,
        );
        expect(getByText('NASA · ISRO')).toBeTruthy();
    });

    it('always renders the provenance caption when the panel renders', () => {
        mockUseShowExtractedMetadata.mockReturnValue(true);
        const { getByText } = render(
            <ExtractedMetadataPanel eventType="weather" entities={null} geoTags={null} />,
        );
        expect(getByText('meraProtocol.extractedMetadataCaption')).toBeTruthy();
    });
});
