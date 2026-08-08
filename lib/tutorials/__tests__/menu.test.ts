import { chaptersAtLevel } from '../chapters';
import {
    ADVANCED_UNLOCK_THRESHOLD,
    buildMenuModel,
    countCompletedBasics,
    isAdvancedUnlocked,
    nextChapterId,
} from '../menu';

const basicIds = chaptersAtLevel('basic').map((c) => c.id);
const advancedIds = chaptersAtLevel('advanced').map((c) => c.id);

const set = (...ids: string[]) => new Set(ids);

describe('the advanced gate', () => {
    it('counts only BASIC chapters — advanced ones do not unlock themselves', () => {
        const completed = set(...advancedIds, basicIds[0]);
        expect(countCompletedBasics(completed)).toBe(1);
        expect(isAdvancedUnlocked(completed)).toBe(false);
    });

    it('opens at exactly the threshold, not one before', () => {
        const justUnder = set(...basicIds.slice(0, ADVANCED_UNLOCK_THRESHOLD - 1));
        const atThreshold = set(...basicIds.slice(0, ADVANCED_UNLOCK_THRESHOLD));

        expect(isAdvancedUnlocked(justUnder)).toBe(false);
        expect(isAdvancedUnlocked(atThreshold)).toBe(true);
    });

    it('ignores ids that are not chapters at all', () => {
        expect(countCompletedBasics(set('not-a-chapter', 'nor-this'))).toBe(0);
    });
});

describe('buildMenuModel', () => {
    it('hides the advanced section entirely while locked', () => {
        const model = buildMenuModel(set());

        expect(model.sections.map((s) => s.level)).toEqual(['basic']);
        expect(model.advancedRemaining).toBe(ADVANCED_UNLOCK_THRESHOLD);
        expect(model.sections[0].rows).toHaveLength(basicIds.length);
    });

    it('reveals it once the threshold is met, with nothing left to go', () => {
        const model = buildMenuModel(set(...basicIds.slice(0, ADVANCED_UNLOCK_THRESHOLD)));

        expect(model.sections.map((s) => s.level)).toEqual(['basic', 'advanced']);
        expect(model.advancedRemaining).toBe(0);
        expect(model.sections[1].rows.map((r) => r.chapter.id)).toEqual(advancedIds);
    });

    it('counts completions across BOTH levels for the progress line', () => {
        const completed = set(...basicIds, ...advancedIds);
        const model = buildMenuModel(completed);

        expect(model.completedCount).toBe(model.totalCount);
        expect(model.sections.flatMap((s) => s.rows).every((r) => r.completed)).toBe(true);
    });

    it('counts down as basics land', () => {
        expect(buildMenuModel(set(basicIds[0])).advancedRemaining).toBe(
            ADVANCED_UNLOCK_THRESHOLD - 1,
        );
    });
});

describe('nextChapterId', () => {
    it('starts at the first basic', () => {
        expect(nextChapterId(set())).toBe(basicIds[0]);
    });

    it('never points at a locked advanced chapter', () => {
        // Every basic bar the last one done — still one short of the gate would
        // be wrong here, so use a set that leaves exactly one basic pending.
        const completed = set(...basicIds.slice(0, basicIds.length - 1));
        expect(nextChapterId(completed)).toBe(basicIds[basicIds.length - 1]);
    });

    it('moves into advanced once everything basic is done', () => {
        expect(nextChapterId(set(...basicIds))).toBe(advancedIds[0]);
    });

    it('falls back to the first chapter when everything is done', () => {
        expect(nextChapterId(set(...basicIds, ...advancedIds))).toBe(basicIds[0]);
    });
});
