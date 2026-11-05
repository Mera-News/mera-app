/** The Your data meter card at its seam: the size read in, the card out. */
import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import DataMeterCard from '@/components/custom/config-mera/DataMeterCard';
import { readLocalDataSizes } from '@/lib/database/local-data-size';
import i18n from '@/lib/i18n';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/lib/database/local-data-size', () => ({ readLocalDataSizes: jest.fn() }));
jest.mock('expo-router', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return { useFocusEffect: (cb: () => void) => React.useEffect(() => cb(), [cb]) };
});

const read = jest.mocked(readLocalDataSizes);
beforeAll(initI18nEn);

describe('DataMeterCard', () => {
    it('shows used and free with the bar', async () => {
        read.mockResolvedValue({ databaseBytes: 100_000_000, modelBytes: null, backupBytes: 0, freeBytes: 900_000_000 });
        await render(<DataMeterCard />);
        expect(await screen.findByText('Mera uses 100 MB. 900 MB free on this phone.')).toBeTruthy();
        expect(screen.getByTestId('data-meter-bar', { includeHiddenElements: true })).toBeTruthy();
    });

    it('adds the model row and the backup row', async () => {
        read.mockResolvedValue({ databaseBytes: 100_000_000, modelBytes: 2_000_000_000, backupBytes: 50_000_000, freeBytes: 5_000_000_000 });
        await render(<DataMeterCard />);
        expect(await screen.findByText('Mera relevance model')).toBeTruthy();
        expect(screen.getByText('Backup copy')).toBeTruthy();
    });

    it('hides the card when the read fails', async () => {
        read.mockResolvedValue(null);
        await render(<DataMeterCard />);
        await act(async () => {});
        expect(read).toHaveBeenCalled();
        expect(screen.queryByTestId('data-meter')).toBeNull();
    });

    it('with unknown free space shows the used-only line and no bar', async () => {
        read.mockResolvedValue({ databaseBytes: 100_000_000, modelBytes: null, backupBytes: 0, freeBytes: null });
        await render(<DataMeterCard />);
        expect(await screen.findByText('Mera uses 100 MB.')).toBeTruthy();
        expect(screen.queryByTestId('data-meter-bar', { includeHiddenElements: true })).toBeNull();
    });
});

describe('DataMeterCard at the largest text and in Arabic', () => {
    const window = Dimensions.get('window');
    const setFontScale = (fontScale: number) =>
        act(() => {
            Dimensions.set({ window: { ...window, fontScale }, screen: Dimensions.get('screen') });
        });
    const direction = (key: string) => StyleSheet.flatten(screen.getByTestId(`data-meter-row-${key}`).props.style).flexDirection;
    const sizes = { databaseBytes: 100_000_000, modelBytes: null, backupBytes: 50_000_000, freeBytes: 900_000_000 };

    afterEach(async () => {
        await setFontScale(window.fontScale);
        await i18n.changeLanguage('en');
    });

    it('stacks label over value at the largest text, and only there', async () => {
        // Jest's window starts at fontScale 2, past the threshold.
        await setFontScale(1);
        read.mockResolvedValue(sizes);
        await render(<DataMeterCard />);
        await screen.findByTestId('data-meter');
        expect(direction('database')).toBe('row');
        await setFontScale(3.1);
        expect(direction('database')).toBe('column');
        expect(direction('backup')).toBe('column');
    });

    it('keeps a 4pt bar when Mera holds almost nothing of the phone', async () => {
        read.mockResolvedValue({ ...sizes, freeBytes: 900_000_000_000 });
        await render(<DataMeterCard />);
        const bar = await screen.findByTestId('data-meter-bar', { includeHiddenElements: true });
        expect(StyleSheet.flatten(bar.props.children.props.style).minWidth).toBe(4);
    });

    it('in Arabic uses the phonetic brand and the locale digits, and the hide rules still hold', async () => {
        await i18n.changeLanguage('ar');
        read.mockResolvedValue(sizes);
        await render(<DataMeterCard />);
        const mb = (n: number) => `${n.toLocaleString('ar')} MB`;
        expect(await screen.findByText(`يستخدم ميرا ${mb(150)}. ${mb(900)} متاحة على هذا الهاتف.`)).toBeTruthy();
        expect(screen.getByTestId('data-meter-bar', { includeHiddenElements: true })).toBeTruthy();

        read.mockResolvedValue({ ...sizes, freeBytes: null });
        screen.unmount();
        await render(<DataMeterCard />);
        expect(await screen.findByText(`يستخدم ميرا ${mb(150)}.`)).toBeTruthy();
        expect(screen.queryByTestId('data-meter-bar', { includeHiddenElements: true })).toBeNull();

        read.mockResolvedValue(null);
        screen.unmount();
        await render(<DataMeterCard />);
        await act(async () => {});
        expect(screen.queryByTestId('data-meter')).toBeNull();
    });
});
