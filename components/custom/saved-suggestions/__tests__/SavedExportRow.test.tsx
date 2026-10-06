/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count != null ? `${k}#${o.count}` : k) }),
}));
jest.mock('@/components/custom/GlassSurface', () => ({ GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)' }));
// The worklet runs once per render here, which is enough to read the offset.
jest.mock('react-native-reanimated', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: { View }, useAnimatedStyle: (fn: () => object) => fn() };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';
import SavedExportRow, { SAVED_EXPORT_ROW_HEIGHT } from '../SavedExportRow';

const rowStyle = () => StyleSheet.flatten(screen.getByTestId('saved-export-row').props.style);

describe('SavedExportRow', () => {
    it('sits directly under the header and states the count', () => {
        render(<SavedExportRow count={3} headerHeight={106} onExport={jest.fn()} />);
        expect(rowStyle().top).toBe(106);
        expect(screen.getByText('library.saved.exportRow#3')).toBeTruthy();
    });

    it('rides with the collapsing header: fully away when it is hidden', () => {
        render(<SavedExportRow count={1} headerHeight={106} hidden={{ value: 1 } as never} onExport={jest.fn()} />);
        expect(rowStyle().transform).toEqual([{ translateY: -(106 + SAVED_EXPORT_ROW_HEIGHT) }]);
    });

    it('stays put with no header binding', () => {
        render(<SavedExportRow count={1} headerHeight={0} onExport={jest.fn()} />);
        expect(rowStyle().transform).toEqual([{ translateY: 0 }]);
    });

    it('Export is one labelled 44pt button that opens the wizard, with no glyph exposed', () => {
        const onExport = jest.fn();
        const r = render(<SavedExportRow count={1} headerHeight={0} onExport={onExport} />);
        // The visual label is there (hidden from accessibility, read via the button).
        expect(screen.getByText('library.saved.export', { includeHiddenElements: true })).toBeTruthy();
        const button = screen.getByTestId('saved-export-open');
        expect(button.props.accessibilityLabel).toBe('savedExport.fabA11y');
        expect(StyleSheet.flatten(screen.getByTestId('saved-export-open-frame').props.style).minHeight).toBe(44);
        fireEvent.press(button);
        expect(onExport).toHaveBeenCalledTimes(1);
        expect(exposedGlyphTexts(r.UNSAFE_root)).toEqual([]);
    });
});
