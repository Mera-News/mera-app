/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// iOS in-tab inset: the tab's own SafeAreaProvider includes the bar.
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 85, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return {
        GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
        GlassPlate: (p: any) => <View {...p} testID="glass-plate" />,
    };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import SavedExportFab from '../SavedExportFab';

const flat = (id: string) =>
    StyleSheet.flatten(screen.getByTestId(id, { includeHiddenElements: true }).props.style);

describe('SavedExportFab', () => {
    it('embedded, sits 20pt above the tab bar and counts the bar once', () => {
        render(<SavedExportFab embedded onPress={jest.fn()} />);
        expect(flat('saved-export-open').bottom).toBe(20 + 85);
    });

    it('always paints a solid base under the glass', () => {
        render(<SavedExportFab embedded onPress={jest.fn()} />);
        expect(flat('saved-export-open-base').backgroundColor).toBe('rgba(18,17,19,0.90)');
    });
});
