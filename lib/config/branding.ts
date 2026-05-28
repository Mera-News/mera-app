// Forker-facing branding. Override via EXPO_PUBLIC_* in .env; defaults are
// the reference (mera.news) values. Keep all user-facing URLs/email here so a
// rebrand touches exactly one file (+ .env), never call sites or locale JSONs.
export const PRIVACY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_URL || 'https://mera.news/privacy';
export const TERMS_URL =
  process.env.EXPO_PUBLIC_TERMS_URL || 'https://mera.news/terms';
export const SUPPORT_EMAIL =
  process.env.EXPO_PUBLIC_SUPPORT_EMAIL || 'contact@mera.news';
export const WEBSITE_URL =
  process.env.EXPO_PUBLIC_WEBSITE_URL || 'https://mera.news';
export const GITHUB_URL =
  process.env.EXPO_PUBLIC_GITHUB_URL || 'https://github.com/Mera-News/mera-app';

// Display label for the website link (protocol/trailing-slash stripped).
export const WEBSITE_LABEL = WEBSITE_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
