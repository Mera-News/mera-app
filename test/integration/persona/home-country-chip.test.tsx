// The home-country chip at its seam: real hook, real fact and location services on the in-memory database.
// Only the phone's region is scripted (expo-localization). The chip never starts a chat turn.
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { getLocales } from 'expo-localization';
import React from 'react';

import { HomeCountryChip } from '@/components/custom/home-country-chip/HomeCountryChip';
import { useHasHomeFact } from '@/components/custom/home-country-chip/home-fact';
import { useHomeCountryChip } from '@/components/custom/home-country-chip/useHomeCountryChip';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn } from '@/test/helpers';
import { quietLogger, seedPlace, settleWrites } from '@/test/integration/data/services/persona/support';

const region = (regionCode: string | null) =>
    jest.mocked(getLocales).mockReturnValue([{ languageCode: 'en', regionCode, languageTag: 'en' }] as never);

beforeAll(initI18nEn);
beforeEach(() => {
    region('NL');
    useAppLanguageStore.setState({ appLanguage: 'en' });
});
afterEach(settleWrites);

describe('useHomeCountryChip', () => {
    it('reads the phone region and names the country in the app language', async () => {
        const { result } = await renderHook(() => useHomeCountryChip());
        await waitFor(() => expect(result.current.country).toEqual({ alpha2: 'NL', label: 'Netherlands' }));
        expect(result.current.status).toBe('idle');
    });

    it('is null when the phone reports no region, never the US fallback', async () => {
        region(null);
        const { result } = await renderHook(() => useHomeCountryChip());
        await act(async () => {});
        expect(result.current.country).toBeNull();
    });

    it('is null for a region that is not a country', async () => {
        region('ZZ');
        const { result } = await renderHook(() => useHomeCountryChip());
        await act(async () => {});
        expect(result.current.country).toBeNull();
    });

    it('save writes one residence fact under the canonical key, no chat turn, and reports the id', async () => {
        const onSaved = jest.fn();
        const { result } = await renderHook(() => useHomeCountryChip(onSaved));
        await waitFor(() => expect(result.current.country).not.toBeNull());
        let ok = false;
        await act(async () => {
            ok = await result.current.save();
        });
        expect(ok).toBe(true);
        const facts = await getFacts();
        expect(facts).toHaveLength(1);
        expect(facts[0].statement).toBe('Lives in the Netherlands');
        expect(facts[0].questionnaireAttribute).toBe(CANONICAL_LOCATION_KEY);
        expect(onSaved).toHaveBeenCalledWith(facts[0].id);
        expect(result.current.status).toBe('saved');
    });

    it('is null once a residence fact exists, so it never adds a second home fact', async () => {
        await addFact('Lives in Berlin, Germany', undefined, { attribute: CANONICAL_LOCATION_KEY });
        const { result } = await renderHook(() => useHomeCountryChip());
        await act(async () => {});
        expect(result.current.country).toBeNull();
        let ok = true;
        await act(async () => {
            ok = await result.current.save();
        });
        expect(ok).toBe(false);
        expect(await getFacts()).toHaveLength(1);
    });

    it('is null once a home location exists, but a work location does not hide it', async () => {
        await seedPlace('NLD', 'Amsterdam', 'work');
        const first = await renderHook(() => useHomeCountryChip());
        await waitFor(() => expect(first.result.current.country).not.toBeNull());
        await seedPlace('NLD', 'Amsterdam', 'home');
        await waitFor(() => expect(first.result.current.country).toBeNull());
    });

    it('a failed write shows the save-failed toast and leaves status error', async () => {
        const logs = quietLogger();
        const toast = jest.spyOn(toastManager, 'showError').mockImplementation(() => undefined as never);
        const facts = await import('@/lib/chat-tools/fact-commit');
        const commit = jest.spyOn(facts, 'commitFactChoices').mockRejectedValueOnce(new Error('disk'));
        const { result } = await renderHook(() => useHomeCountryChip());
        await waitFor(() => expect(result.current.country).not.toBeNull());
        let ok = true;
        await act(async () => {
            ok = await result.current.save();
        });
        expect(ok).toBe(false);
        expect(result.current.status).toBe('error');
        expect(toast).toHaveBeenCalledWith("Couldn't save place", 'Please try again.');
        commit.mockRestore();
        toast.mockRestore();
        logs.restore();
    });
});

describe('useHasHomeFact', () => {
    it('is false on an empty device, true once a residence fact lands', async () => {
        const { result } = await renderHook(() => useHasHomeFact());
        await waitFor(() => expect(result.current).toBe(false));
        await addFact('Lives in Berlin, Germany', undefined, { attribute: CANONICAL_LOCATION_KEY });
        await waitFor(() => expect(result.current).toBe(true));
    });

    it('an interest fact is not a home fact', async () => {
        await addFact('Follows Formula 1');
        const { result } = await renderHook(() => useHasHomeFact());
        await waitFor(() => expect(result.current).toBe(false));
    });
});

describe('HomeCountryChip', () => {
    it('renders nothing with no region', async () => {
        region(null);
        await render(<HomeCountryChip />);
        await act(async () => {});
        expect(screen.queryByTestId('home-country-chip')).toBeNull();
    });

    it.each([
        ['NL', 'I live in the Netherlands'],
        ['US', 'I live in the United States'],
        ['GB', 'I live in the United Kingdom'],
        ['PH', 'I live in the Philippines'],
        ['DE', 'I live in Germany'],
        ['IN', 'I live in India'],
    ])('%s reads "%s"', async (code, text) => {
        region(code);
        await render(<HomeCountryChip />);
        expect(await screen.findByText(text)).toBeTruthy();
    });

    it('a tap saves the fact and calls onSaved, and the label is never truncated', async () => {
        const onSaved = jest.fn();
        await render(<HomeCountryChip onSaved={onSaved} />);
        const chip = await screen.findByTestId('home-country-chip');
        expect(screen.getByText(/I live in the Netherlands/).props.numberOfLines).toBeUndefined();
        fireEvent.press(chip);
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(await getFacts()).toHaveLength(1);
    });

    it('a second tap while saving writes once', async () => {
        await render(<HomeCountryChip />);
        const chip = await screen.findByTestId('home-country-chip');
        fireEvent.press(chip);
        fireEvent.press(chip);
        await waitFor(async () => expect(await getFacts()).toHaveLength(1));
        await settleWrites();
        expect(await getFacts()).toHaveLength(1);
    });

    it('hides when a home fact already exists', async () => {
        await addFact('Lives in Berlin, Germany', undefined, { attribute: CANONICAL_LOCATION_KEY });
        await render(<HomeCountryChip />);
        await act(async () => {});
        expect(screen.queryByTestId('home-country-chip')).toBeNull();
    });
});
