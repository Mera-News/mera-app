/** The Your data meter card at its seam: the size read in, the card out. */
import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import DataMeterCard from '@/components/custom/config-mera/DataMeterCard';
import { readLocalDataSizes } from '@/lib/database/local-data-size';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/lib/database/local-data-size', () => ({ readLocalDataSizes: jest.fn() }));
jest.mock('expo-router', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return { useFocusEffect: (cb: () => void) => React.useEffect(cb, []) };
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
