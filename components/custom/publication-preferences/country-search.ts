import { getCountryName } from '@/lib/algorithms/country-utils';
import countries from 'i18n-iso-countries';

// Static requires so Metro bundles them; each file registers on first use only.
// shortcut: zh-TW has no i18n-iso-countries file, so it reads English names; add one if a Traditional list appears.
const LOCALE_FILES: Readonly<Record<string, { file: string; load: () => unknown }>> = {
    ar: { file: 'ar', load: () => require('i18n-iso-countries/langs/ar.json') },
    de: { file: 'de', load: () => require('i18n-iso-countries/langs/de.json') },
    es: { file: 'es', load: () => require('i18n-iso-countries/langs/es.json') },
    fr: { file: 'fr', load: () => require('i18n-iso-countries/langs/fr.json') },
    hi: { file: 'hi', load: () => require('i18n-iso-countries/langs/hi.json') },
    id: { file: 'id', load: () => require('i18n-iso-countries/langs/id.json') },
    it: { file: 'it', load: () => require('i18n-iso-countries/langs/it.json') },
    ja: { file: 'ja', load: () => require('i18n-iso-countries/langs/ja.json') },
    ko: { file: 'ko', load: () => require('i18n-iso-countries/langs/ko.json') },
    nl: { file: 'nl', load: () => require('i18n-iso-countries/langs/nl.json') },
    pl: { file: 'pl', load: () => require('i18n-iso-countries/langs/pl.json') },
    'pt-BR': { file: 'pt', load: () => require('i18n-iso-countries/langs/pt.json') },
    ru: { file: 'ru', load: () => require('i18n-iso-countries/langs/ru.json') },
    th: { file: 'th', load: () => require('i18n-iso-countries/langs/th.json') },
    tr: { file: 'tr', load: () => require('i18n-iso-countries/langs/tr.json') },
    uk: { file: 'uk', load: () => require('i18n-iso-countries/langs/uk.json') },
    vi: { file: 'vi', load: () => require('i18n-iso-countries/langs/vi.json') },
    'zh-CN': { file: 'zh', load: () => require('i18n-iso-countries/langs/zh.json') },
};

const registered = new Set<string>();

/** The library language for an app language, registered on first use; 'en' when there is none. */
function libLanguage(appLanguage: string): string {
    const entry = LOCALE_FILES[appLanguage];
    if (!entry) return 'en';
    if (!registered.has(entry.file)) {
        countries.registerLocale(entry.load() as Parameters<typeof countries.registerLocale>[0]);
        registered.add(entry.file);
    }
    return entry.file;
}

/** A country's name in the app language (English where the language has no list). */
export function localizedCountryName(alpha3: string, appLanguage: string): string {
    const lang = libLanguage(appLanguage);
    return (lang !== 'en' && countries.getName(alpha3, lang)) || getCountryName(alpha3);
}

export interface SourceCountryHit {
    readonly alpha2: string;
    readonly alpha3: string;
    /** In the app language. */
    readonly name: string;
    /** The English name the scope row stores. */
    readonly label: string;
}

const MAX_HITS = 5;

/** Countries whose name (app language, or any English name or alias) contains the query; start-of-name matches first. */
export function searchSourceCountries(query: string, appLanguage: string): SourceCountryHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const lang = libLanguage(appLanguage);
    const found: { hit: SourceCountryHit; rank: number }[] = [];
    for (const alpha2 of Object.keys(countries.getAlpha2Codes())) {
        const alpha3 = countries.alpha2ToAlpha3(alpha2);
        if (!alpha3) continue;
        const name = (lang !== 'en' && countries.getName(alpha2, lang)) || getCountryName(alpha3);
        const names = [name, ...(countries.getName(alpha2, 'en', { select: 'all' }) ?? [])].map((n) => n.toLowerCase());
        if (!names.some((n) => n.includes(q))) continue;
        found.push({
            hit: { alpha2, alpha3, name, label: getCountryName(alpha3) },
            rank: names.some((n) => n.startsWith(q)) ? 0 : 1,
        });
    }
    found.sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name));
    return found.slice(0, MAX_HITS).map((f) => f.hit);
}
