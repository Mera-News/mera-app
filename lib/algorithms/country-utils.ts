import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';

countries.registerLocale(en);

export const getFlagEmoji = (alpha3Code: string | null | undefined): string => {
    if (!alpha3Code) return '';
    if (alpha3Code === 'GLOBAL') return '🌍';
    const alpha2 = countries.alpha3ToAlpha2(alpha3Code);
    if (!alpha2) return '';
    const codePoints = [...alpha2.toUpperCase()].map((c) => 127397 + c.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
};

/**
 * Where the library's alias is an abbreviation, carries "The" or reads like
 * an official form (or, for Taiwan, where any other form would read
 * "Province of China"), the plain short name. Every other country keeps its alias ("Russia", "Vietnam",
 * "Iran"), which reads better than the official form.
 */
const NAME_OVERRIDES: Readonly<Record<string, string>> = {
    GB: 'United Kingdom',
    NL: 'Netherlands',
    AE: 'United Arab Emirates',
    GM: 'Gambia',
    TW: 'Taiwan',
    // Aliases that read like official forms.
    KR: 'South Korea',
    LA: 'Laos',
    SY: 'Syria',
};

export const getCountryName = (alpha3Code: string): string => {
    const alpha2 = countries.alpha3ToAlpha2(alpha3Code);
    return (
        (alpha2 && NAME_OVERRIDES[alpha2]) ||
        countries.getName(alpha3Code, 'en', { select: 'alias' }) ||
        alpha3Code
    );
};
