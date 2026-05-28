import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

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
