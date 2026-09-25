/**
 * The count seam delegates to the data area's query and passes only CHANGES
 * on, since the controller acts on edges. It must never query inference_jobs
 * itself: the database module is not mocked here, so a direct query would die
 * on the SQLite adapter at require time.
 */
import { of } from 'rxjs';
import { toArray } from 'rxjs/operators';

const mockServiceCount = jest.fn(() => of(1, 1, 2, 2, 0));

jest.mock('@/lib/database/services/combo-pass-service', () => ({
    observeActiveComboJobCount: () => mockServiceCount(),
}));

import { observeActiveComboJobCount } from '../facts-combo-source';

describe('observeActiveComboJobCount (toast seam)', () => {
    it("reads the data service's observable and drops repeats", async () => {
        const seen = await observeActiveComboJobCount().pipe(toArray()).toPromise();
        expect(mockServiceCount).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([1, 2, 0]);
    });
});
