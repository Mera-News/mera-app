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

export const getCountryName = (alpha3Code: string): string => {
    return countries.getName(alpha3Code, 'en', { select: 'alias' }) || alpha3Code;
};
