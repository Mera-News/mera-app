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
export const FAQ_URL =
  process.env.EXPO_PUBLIC_FAQ_URL || 'https://mera.news/faq';
export const SUPPORT_EMAIL =
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL || 'contact@mera.news';
export const WEBSITE_URL =
  process.env.EXPO_PUBLIC_WEBSITE_URL || 'https://mera.news';
export const GITHUB_URL =
  process.env.EXPO_PUBLIC_GITHUB_URL || 'https://github.com/Mera-News/mera-app';
// How-to videos: one per kind, platform and app language, named
// <kind>-<ios|android>-<app language code>.mp4 (built in mera-social, hosted in
// mera-infra's guides bucket). A function, not a constant, so the language is
// the one the reader has when the guide opens.
export type GuideVideoKind = 'translate' | 'phone-language';
const GUIDE_VIDEO_BASE_URL =
  process.env.EXPO_PUBLIC_GUIDE_VIDEO_BASE_URL ||
  'https://storage.googleapis.com/mera-news-prod-guides';
export function guideVideoUrl(kind: GuideVideoKind, appLanguage: string): string {
  const platform = Platform.OS === 'android' ? 'android' : 'ios';
  return `${GUIDE_VIDEO_BASE_URL}/${kind}-${platform}-${appLanguage}.mp4`;
}

// utm_source value appended to publisher article URLs so publishers can
// attribute the visit to us. Derived from WEBSITE_URL's host (e.g. mera.news)
// so a rebrand needs no extra config.
export const REFERRER_SOURCE =
  process.env.EXPO_PUBLIC_REFERRER_SOURCE ||
  WEBSITE_URL.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
