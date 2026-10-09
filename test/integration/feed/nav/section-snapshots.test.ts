// snapshotsEqual: an identical reload must keep the same object, so the sections list does not
// re-render on every return to the page.
import { snapshotsEqual } from '@/components/custom/for-you/use-section-snapshots';
import type { SectionSnapshots } from '@/lib/stores/section-snapshots';

const make = (statement: string): SectionSnapshots =>
    ({
        topics: new Map([['t1', { id: 't1', text: 'rail strikes' }]]),
        facts: new Map([['f1', { id: 'f1', statement }]]),
        locations: new Map(),
        factStatements: new Map([['f1', statement]]),
        hasTopics: true,
    }) as unknown as SectionSnapshots;

describe('snapshotsEqual', () => {
    it('treats an identical reload as equal, so the Dashboard keeps its object', () => {
        expect(snapshotsEqual(make('I live in Utrecht'), make('I live in Utrecht'))).toBe(true);
    });

    it('sees a changed row (positive control)', () => {
        expect(snapshotsEqual(make('I live in Utrecht'), make('I live in Delft'))).toBe(false);
    });
});
