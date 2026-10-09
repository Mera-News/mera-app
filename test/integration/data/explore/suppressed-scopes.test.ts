// Seam test for the hidden-scope set: one settings row, `explore_suppressed_scopes`, on the
// in-memory DB. Only `country:` ids survive, on every read and write.
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
    addSuppressedScopeId,
    getSuppressedScopeIds,
    removeSuppressedScopeId,
} from '@/lib/explore/suppressed-scopes';

const KEY = 'explore_suppressed_scopes';
const stored = async () => JSON.parse((await getSetting(KEY)) ?? 'null');

describe('getSuppressedScopeIds', () => {
    it('is empty when nothing is stored', async () => {
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    it('is empty for garbage JSON rather than throwing', async () => {
        await setSetting(KEY, '{not valid');
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    it('is empty when the row is valid JSON but not an array', async () => {
        await setSetting(KEY, JSON.stringify('country:IND'));
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    it('filters non-string members and dedupes', async () => {
        await setSetting(KEY, JSON.stringify(['country:IND', 7, 'country:IND', 'country:FRA']));
        expect(await getSuppressedScopeIds()).toEqual(['country:IND', 'country:FRA']);
    });

    // A restore writes the backed-up row verbatim, so a pre-navx device brings its old city and
    // region entries back. They must vanish on read, with no migration.
    it('drops legacy city and region entries seeded the way a restore writes them', async () => {
        await setSetting(KEY, JSON.stringify(['city:IND:mumbai', 'country:IND', 'region:FRA:bretagne']));
        expect(await getSuppressedScopeIds()).toEqual(['country:IND']);
    });

    it('drops legacy entries on a write too, so the row is clean afterwards', async () => {
        await setSetting(KEY, JSON.stringify(['city:IND:mumbai', 'country:IND', 'region:FRA:bretagne']));
        expect(await addSuppressedScopeId('country:FRA')).toEqual(['country:IND', 'country:FRA']);
        expect(await stored()).toEqual(['country:IND', 'country:FRA']);
    });

    it('drops legacy entries when removing another id', async () => {
        await setSetting(KEY, JSON.stringify(['city:IND:mumbai', 'country:IND', 'country:FRA']));
        expect(await removeSuppressedScopeId('country:FRA')).toEqual(['country:IND']);
        expect(await stored()).toEqual(['country:IND']);
    });

    it('never surfaces "world" even if it was persisted', async () => {
        await setSetting(KEY, JSON.stringify(['world', 'country:IND']));
        expect(await getSuppressedScopeIds()).toEqual(['country:IND']);
    });

    it('trims ids before testing the prefix', async () => {
        await setSetting(KEY, JSON.stringify(['  country:IND  ']));
        expect(await getSuppressedScopeIds()).toEqual(['country:IND']);
    });
});

describe('addSuppressedScopeId', () => {
    it('adds to an empty set and persists it', async () => {
        expect(await addSuppressedScopeId('country:IND')).toEqual(['country:IND']);
        expect(await stored()).toEqual(['country:IND']);
    });

    it('is idempotent', async () => {
        await addSuppressedScopeId('country:IND');
        expect(await addSuppressedScopeId('country:IND')).toEqual(['country:IND']);
    });

    it('refuses to hide "world" or a city id', async () => {
        expect(await addSuppressedScopeId('world')).toEqual([]);
        expect(await addSuppressedScopeId('city:IND:mumbai')).toEqual([]);
        expect(await getSuppressedScopeIds()).toEqual([]);
    });

    it('appends to an existing set', async () => {
        await addSuppressedScopeId('country:IND');
        expect(await addSuppressedScopeId('country:FRA')).toEqual(['country:IND', 'country:FRA']);
    });

    it('treats a null or undefined id as blank rather than throwing', async () => {
        expect(await addSuppressedScopeId(null as unknown as string)).toEqual([]);
        expect(await addSuppressedScopeId(undefined as unknown as string)).toEqual([]);
    });
});

describe('removeSuppressedScopeId', () => {
    it('is a no-op on an empty set', async () => {
        expect(await removeSuppressedScopeId('country:IND')).toEqual([]);
    });

    it('removes a present id', async () => {
        await addSuppressedScopeId('country:IND');
        await addSuppressedScopeId('country:FRA');
        expect(await removeSuppressedScopeId('country:IND')).toEqual(['country:FRA']);
        expect(await stored()).toEqual(['country:FRA']);
    });

    it('is idempotent', async () => {
        await addSuppressedScopeId('country:IND');
        expect(await removeSuppressedScopeId('country:FRA')).toEqual(['country:IND']);
        expect(await removeSuppressedScopeId('country:FRA')).toEqual(['country:IND']);
    });
});
