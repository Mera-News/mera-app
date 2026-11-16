// The one-tap "I live in {country}" chip's state. Onboarding's gate, the Feed's zero-fact card and the World row
// share it. No chat turn, works offline. The country comes from the phone's region and is null when there is none
// (never the 'US' fallback of getDeviceCountryAlpha2), or when a home already exists.
import { getLocales } from 'expo-localization';
import countries from 'i18n-iso-countries';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { localizedCountryName } from '@/components/custom/publication-preferences/country-search';
import { getCountryName } from '@/lib/algorithms/country-utils';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import logger from '@/lib/logger';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { toastManager } from '@/lib/toast-manager';
import { hasHomeFact, useHasHomeFact } from './home-fact';

export type HomeChipStatus = 'idle' | 'saving' | 'saved' | 'error';

// English names that take "the". shortcut: English only and short, extend when a country reads wrong;
// other languages carry the English text until translated.
const TAKES_THE = new Set([
    'Netherlands', 'United States', 'United States of America', 'United Kingdom', 'Philippines',
    'United Arab Emirates', 'Bahamas', 'Gambia', 'Czech Republic', 'Maldives', 'Seychelles', 'Comoros',
    'Marshall Islands', 'Solomon Islands', 'Central African Republic', 'Dominican Republic',
    'Democratic Republic of the Congo', 'Republic of the Congo', 'Cayman Islands', 'Cook Islands',
    'Faroe Islands', 'Turks and Caicos Islands',
]);

/** "the Netherlands" for a bare English name that takes the article, else the bare name. */
const withArticle = (englishName: string) => (TAKES_THE.has(englishName) ? `the ${englishName}` : englishName);

export function homeChipTakesThe(englishName: string): boolean {
    return TAKES_THE.has(englishName);
}

export function useHomeCountryChip(onSaved?: (factId: string) => void) {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    const hasHome = useHasHomeFact();
    const [status, setStatus] = useState<HomeChipStatus>('idle');
    const busy = useRef(false);

    const alpha2 = (getLocales()[0]?.regionCode ?? '').trim().toUpperCase();
    const alpha3 = alpha2 ? countries.alpha2ToAlpha3(alpha2) : undefined;
    const country = useMemo(
        () => (alpha3 && hasHome === false ? { alpha2, label: localizedCountryName(alpha3, appLanguage) } : null),
        [alpha2, alpha3, hasHome, appLanguage],
    );

    const save = useCallback(async (): Promise<boolean> => {
        if (!alpha3 || busy.current) return false;
        busy.current = true;
        setStatus('saving');
        try {
            // Re-read: a home may have landed since the hook last emitted.
            if (await hasHomeFact()) {
                setStatus('idle');
                return false;
            }
            const { savedFacts } = await commitFactChoices([
                {
                    statement: `Lives in ${withArticle(getCountryName(alpha3))}`,
                    questionnaire: { attribute: CANONICAL_LOCATION_KEY },
                    skillId: 'topics/residence',
                },
            ]);
            setStatus('saved');
            if (savedFacts[0]) onSaved?.(savedFacts[0].id);
            return true;
        } catch (error) {
            logger.captureException(error, { tags: { component: 'HomeCountryChip', method: 'save' } });
            toastManager.showError(t('locations.saveFailedTitle'), t('locations.saveFailedBody'));
            setStatus('error');
            return false;
        } finally {
            busy.current = false;
        }
    }, [alpha3, onSaved, t]);

    return { country, status, save };
}

/** The chip's sentence, with the right grammar for the country. */
export function homeChipLabel(t: (k: 'onboarding.homeChip' | 'onboarding.homeChipThe', o: { country: string }) => string, alpha2: string, label: string, appLanguage: string): string {
    const alpha3 = countries.alpha2ToAlpha3(alpha2);
    const the = appLanguage === 'en' && !!alpha3 && TAKES_THE.has(getCountryName(alpha3));
    return t(the ? 'onboarding.homeChipThe' : 'onboarding.homeChip', { country: label });
}
