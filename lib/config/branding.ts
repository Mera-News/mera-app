import { Platform } from 'react-native';

// Forker-facing branding. Override via EXPO_PUBLIC_* in .env; defaults are
// the reference (mera.news) values. Keep all user-facing URLs/email here so a
// rebrand touches exactly one file (+ .env), never call sites or locale JSONs.
export const PRIVACY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_URL || 'https://mera.news/privacy';
export const TERMS_URL =
  process.env.EXPO_PUBLIC_TERMS_URL || 'https://mera.news/terms';
export const CONTENT_POLICY_URL =
  process.env.EXPO_PUBLIC_CONTENT_POLICY_URL ||
  'https://mera.news/content-policy';
export const SUPPORT_EMAIL =
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL || 'contact@mera.news';
export const WEBSITE_URL =
  process.env.EXPO_PUBLIC_WEBSITE_URL || 'https://mera.news';
export const GITHUB_URL =
  process.env.EXPO_PUBLIC_GITHUB_URL || 'https://github.com/Mera-News/mera-app';
export const TRANSLATION_GUIDE_URL =
  process.env.EXPO_PUBLIC_TRANSLATION_GUIDE_URL ||
  `https://mera.news/assets/translation-guide-${
    Platform.OS === 'android' ? 'android' : 'ios'
  }.mp4`;

// utm_source value appended to publisher article URLs so publishers can
// attribute the visit to us. Derived from WEBSITE_URL's host (e.g. mera.news)
// so a rebrand needs no extra config.
export const REFERRER_SOURCE =
  process.env.EXPO_PUBLIC_REFERRER_SOURCE ||
  WEBSITE_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
