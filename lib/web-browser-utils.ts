import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import { REFERRER_SOURCE } from './config/branding';
import { useAppLanguageStore } from './stores/app-language-store';

const REFERRER_PARAMS = `utm_source=${REFERRER_SOURCE}&utm_medium=referral`;

/**
 * Appends the user's current app language as a `?lang=<code>` param so a
 * first-party page (privacy, terms, content policy) opens in that language.
 * English (the default) is left as-is to keep canonical URLs clean, and an
 * existing `lang` param is never overridden. Reads the language store
 * non-reactively — safe to call from event handlers.
 */
export function withAppLanguage(url: string): string {
    if (!url) return url;
    if (/[?&]lang=/i.test(url)) return url;

    const lang = useAppLanguageStore.getState().appLanguage;
    if (!lang || lang === 'en') return url;

    const hashIndex = url.indexOf('#');
    const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}lang=${encodeURIComponent(lang)}${fragment}`;
}

/**
 * Appends Mera's UTM referrer params to a publisher article URL so the
 * publisher can attribute the visit to Mera. Handles existing query strings
 * and fragments, and leaves URLs that already carry a utm_source untouched
 * (so we don't clobber a publisher's own campaign tracking).
 */
export function appendReferrer(url: string): string {
    if (!url) return url;
    // Don't override an existing campaign source.
    if (/[?&]utm_source=/i.test(url)) return url;

    const hashIndex = url.indexOf('#');
    const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}${REFERRER_PARAMS}${fragment}`;
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
