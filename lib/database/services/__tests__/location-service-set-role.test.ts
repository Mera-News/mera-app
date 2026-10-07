jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { setRole } from '../location-service';

const db = database as unknown as { _setRows: (t: string, rows: unknown[]) => void; batch: jest.Mock };

function place(id: string, role: string, extra: Record<string, unknown> = {}) {
    return makeRecord({
        id,
        city: 'Amsterdam',
        countryCode: 'NL',
        role,
        pinnedForWeather: false,
        prepareDestroyPermanently: jest.fn(() => ({ destroy: id })),
        ...extra,
    });
}

describe('setRole', () => {
    beforeEach(() => db.batch.mockClear());

    it('relabels in place when the new role has no twin', async () => {
        const home = place('a', 'home');
        db._setRows('locations', [home]);
        await setRole('a', 'work');
        expect(home.role).toBe('work');
        expect(db.batch).not.toHaveBeenCalled();
    });

    it('removes this row and keeps the twin, moving the weather pin', async () => {
        const home = place('a', 'home', { pinnedForWeather: true });
        const work = place('b', 'work', { city: ' amsterdam ' });
        db._setRows('locations', [home, work]);
        await setRole('a', 'work');
        expect(home.prepareDestroyPermanently).toHaveBeenCalled();
        expect(work.pinnedForWeather).toBe(true);
        expect(home.role).toBe('home');
    });

    it('does nothing for the same role', async () => {
        const home = place('a', 'home');
        db._setRows('locations', [home]);
        await setRole('a', 'home');
        expect(home.update).not.toHaveBeenCalled();
    });
});
