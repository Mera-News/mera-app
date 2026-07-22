import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { REFERRER_SOURCE } from './config/branding';
import { useAppLanguageStore } from './stores/app-language-store';

// The website's supported locale codes (mirrors mera-promo-website
// lib/languages.ts). Used to avoid double-injecting a locale segment.
const WEB_LOCALES = new Set([
    'en', 'ar', 'zh-Hans', 'zh-Hant', 'nl', 'fr', 'de', 'hi', 'id', 'it',
    'ja', 'ko', 'pl', 'pt', 'ru', 'es', 'th', 'tr', 'uk', 'vi',
]);

/**
 * Injects the user's current app language as the first path segment of a
 * first-party website URL (privacy, terms, content policy) so the page opens
 * localized — e.g. https://mera.news/privacy → https://mera.news/{lang}/privacy.
 * The site uses path-based locale routing (Next.js [lang] segment), so every
 * locale (incl. English) is prefixed; this avoids the proxy's redirect hop.
 * If the first segment is already a supported locale, the URL is returned
 * unchanged. Reads the language store non-reactively — safe from event handlers.
 */
export function withAppLanguage(url: string): string {
    if (!url) return url;

    const lang = useAppLanguageStore.getState().appLanguage || 'en';

    const match = url.match(/^(https?:\/\/[^/]+)(\/[^?#]*)?([?#].*)?$/i);
    if (!match) return url;
    const [, origin, rawPath = '', suffix = ''] = match;

    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length > 0 && WEB_LOCALES.has(segments[0])) return url;

    const rest = segments.length > 0 ? `/${segments.join('/')}` : '';
    return `${origin}/${lang}${rest}${suffix}`;
}

/**
 * Appends Mera's UTM referrer params to a publisher article URL so the
 * publisher can attribute the visit to Mera. Handles existing query strings
 * and fragments, and leaves URLs that already carry a utm_source untouched
 * (so we don't clobber a publisher's own campaign tracking).
 *
 * `medium` becomes the `utm_medium` value so callers can distinguish an
 * in-app open (`referral`, the default) from a share (`share`).
 */
export function appendReferrer(url: string, medium: string = 'referral'): string {
    if (!url) return url;
    // Don't override an existing campaign source.
    if (/[?&]utm_source=/i.test(url)) return url;

    const params = `utm_source=${REFERRER_SOURCE}&utm_medium=${medium}`;
    const hashIndex = url.indexOf('#');
    const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}${params}${fragment}`;
}

/**
 * Opens a URL in an in-app browser.
 *
 * On Android, this explicitly selects a browser that supports Chrome Custom Tabs
 * to prevent the URL from opening in the user's default external browser
 * (e.g., Mi Browser on Xiaomi devices).
 *
 * On iOS, this uses SFSafariViewController with PAGE_SHEET presentation.
 */
export async function openInAppBrowser(url: string): Promise<WebBrowser.WebBrowserResult> {
    const baseOptions: WebBrowser.WebBrowserOpenOptions = {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor: '#ffffff',
        toolbarColor: '#000000',
    };

    if (Platform.OS === 'android') {
        // Get browsers that support Chrome Custom Tabs
        const browsers = await WebBrowser.getCustomTabsSupportingBrowsersAsync();

        if (browsers.browserPackages.length > 0) {
            // Prefer Chrome, otherwise use first available Custom Tabs-supporting browser
            const chromePackage = browsers.browserPackages.find(pkg =>
                pkg.includes('chrome') || pkg.includes('com.android.chrome')
            );

            return WebBrowser.openBrowserAsync(url, {
                ...baseOptions,
                browserPackage: chromePackage || browsers.browserPackages[0],
                createTask: false, // Keep in same task for in-app feel
                showTitle: true,
                enableBarCollapsing: true,
            });
        }
    }

    return WebBrowser.openBrowserAsync(url, baseOptions);
}

/**
 * Opens an external publisher article URL in the in-app browser with Mera's
 * UTM referrer params appended. Use this for article links; use
 * {@link openInAppBrowser} directly for first-party URLs (privacy, terms, etc.).
 */
export async function openArticleInAppBrowser(
    url: string
): Promise<WebBrowser.WebBrowserResult> {
    return openInAppBrowser(appendReferrer(url));
}
