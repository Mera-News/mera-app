// The Feed's geo/language context is a SESSION snapshot, like its sort
// partition (batch 17). A live context re-ran buildFeedList on every
// publication-preference write: "More from this publication" regrouped and
// re-banded the stories already on screen ~1.6s after the tap, scrolled the
// liked card away and raised a "New stories" pill. A preference change now
// reaches the Feed at the next reading session, never under the reader.
import { renderHook } from '@testing-library/react-native';
import { useSessionGeoLanguageContext } from '../use-session-geo-context';

const ctx = (lang: string, preferred: string[]) => ({
    homeCountryAlpha3: 'NLD',
    otherCountriesAlpha3: [],
    appLanguageBase: lang,
    preferredPublications: new Set(preferred),
});

describe('useSessionGeoLanguageContext', () => {
    it('takes the first loaded context, then holds it through a preference change', () => {
        const first = ctx('en', []);
        const { result, rerender } = renderHook(({ live, epoch }: { live: any; epoch: number }) => useSessionGeoLanguageContext(live, epoch), {
            initialProps: { live: null as any, epoch: 0 },
        });
        expect(result.current).toBeNull();
        rerender({ live: first, epoch: 0 });
        expect(result.current).toBe(first);
        // A boost for IT Pro: same language, new preferred publications.
        rerender({ live: ctx('en', ['it pro']), epoch: 0 });
        expect(result.current).toBe(first);
    });

    it('takes the live context at a new reading session', () => {
        const first = ctx('en', []);
        const later = ctx('en', ['it pro']);
        const { result, rerender } = renderHook(({ live, epoch }: { live: any; epoch: number }) => useSessionGeoLanguageContext(live, epoch), {
            initialProps: { live: first as any, epoch: 0 },
        });
        rerender({ live: later, epoch: 0 });
        expect(result.current).toBe(first);
        rerender({ live: later, epoch: 1 });
        expect(result.current).toBe(later);
    });

    it('follows an app-language change at once (the whole screen changes language anyway)', () => {
        const first = ctx('en', []);
        const german = ctx('de', []);
        const { result, rerender } = renderHook(({ live, epoch }: { live: any; epoch: number }) => useSessionGeoLanguageContext(live, epoch), {
            initialProps: { live: first as any, epoch: 0 },
        });
        rerender({ live: german, epoch: 0 });
        expect(result.current).toBe(german);
    });
});
