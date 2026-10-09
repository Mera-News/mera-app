// The two pure date helpers on ArticleService. They need lib/article-service loaded, hence this
// project. Times are built in local time, so the cases hold in any timezone.
import ArticleService from '@/lib/article-service';
import { useFakeClock } from '@/test/helpers';

describe('ArticleService.getFloorOfHour', () => {
    it('zeroes minutes, seconds and milliseconds and keeps the hour and day', () => {
        const input = new Date(2024, 5, 15, 14, 37, 45, 123);
        expect(ArticleService.getFloorOfHour(input).getTime()).toBe(new Date(2024, 5, 15, 14, 0, 0, 0).getTime());
    });

    it('does not mutate the input date', () => {
        const input = new Date(2024, 5, 15, 14, 37, 45, 123);
        const before = input.getTime();
        ArticleService.getFloorOfHour(input);
        expect(input.getTime()).toBe(before);
    });

    it('leaves a date already on the hour (midnight) unchanged', () => {
        const midnight = new Date(2024, 5, 15, 0, 0, 0, 0);
        expect(ArticleService.getFloorOfHour(midnight).getTime()).toBe(midnight.getTime());
    });

    it('defaults to the current hour', () => {
        useFakeClock(new Date(2024, 5, 15, 14, 37, 45, 123));
        expect(ArticleService.getFloorOfHour().getTime()).toBe(new Date(2024, 5, 15, 14, 0, 0, 0).getTime());
    });
});

describe('ArticleService.getFlooredDateHoursAgo', () => {
    beforeEach(() => useFakeClock(new Date(2024, 5, 15, 14, 37, 45, 123)));

    it('is the hour N hours ago, floored, as an ISO string', () => {
        const result = ArticleService.getFlooredDateHoursAgo(24);
        expect(result).toBe(new Date(2024, 5, 14, 14, 0, 0, 0).toISOString());
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('floors a one-hour offset to the previous full hour', () => {
        expect(ArticleService.getFlooredDateHoursAgo(1)).toBe(new Date(2024, 5, 15, 13, 0, 0, 0).toISOString());
    });

    it('is stable for every call inside the same hour (backend cache key)', () => {
        const first = ArticleService.getFlooredDateHoursAgo(6);
        jest.setSystemTime(new Date(2024, 5, 15, 14, 59, 59, 999));
        expect(ArticleService.getFlooredDateHoursAgo(6)).toBe(first);
    });
});
