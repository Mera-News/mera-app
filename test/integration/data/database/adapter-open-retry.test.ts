// MERA-APP-8P: opening SQLite at module load throws "database is locked" when the previous JS
// runtime (an OTA reload) still holds the file. createAdapterWithRetry waits and tries again.
import { createAdapterWithRetry } from '@/lib/database/index';

const failing = (message: string, times: number) => {
    let calls = 0;
    const factory = jest.fn(() => {
        calls += 1;
        if (calls <= times) throw new Error(message);
        return { adapter: calls };
    });
    return factory;
};

describe('createAdapterWithRetry', () => {
    it('retries a locked database and returns the adapter once it opens', () => {
        const factory = failing('Error code 5: database is locked', 2);

        const started = Date.now();
        expect(createAdapterWithRetry(factory)).toEqual({ adapter: 3 });
        expect(factory).toHaveBeenCalledTimes(3);
        // It waits between attempts, so the old runtime has time to let go.
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    });

    it('rethrows after three retries when the lock never clears', () => {
        const factory = failing('database is locked', Infinity);

        expect(() => createAdapterWithRetry(factory)).toThrow('database is locked');
        expect(factory).toHaveBeenCalledTimes(4);
    });

    it('rethrows any other error at once', () => {
        const factory = failing('no such table: settings', Infinity);

        expect(() => createAdapterWithRetry(factory)).toThrow('no such table');
        expect(factory).toHaveBeenCalledTimes(1);
    });
});
