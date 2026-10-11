import AppPreferencesTab from '@/components/custom/config-mera/AppPreferencesTab';
import { PAGE_CONTENT_GAP, pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageHeaderBinding, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import { DEFAULT_PAGE_ORDER } from '@/lib/navigation/page-order';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import ProfileHub from './ProfileHub';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';

/** Settings: app settings only, plan card first. Ends above the tab bar
 *  and the Mera button. */
const SettingsPage: React.FC<{ readonly header: PageHeaderBinding }> = ({ header }) => {
    const endClearance = useListEndClearance();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.ScrollView>(null);
    usePageScrollTarget(listRef);
    return (
        <Animated.ScrollView
            ref={listRef}
            testID="settings-page"
            onScroll={header.scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: header.headerHeight + PAGE_CONTENT_GAP, paddingBottom: endClearance }}
        >
            <AppPreferencesTab />
        </Animated.ScrollView>
    );
};

/** Each page's icon on the track (outline MaterialIcons on both platforms). */
const ICONS: Readonly<Record<string, NonNullable<PagePill['icon']>>> = {
    profile: 'person-outline',
    settings: 'settings',
};

/** One tab's page set as pills: its fixed order from `DEFAULT_PAGE_ORDER`. */
function usePills(tab: 'profile' | 'you'): PagePill[] {
    const { t } = useTranslation();
    // Registry label keys are computed, so they go through an untyped t.
    const tAny = useMemo(() => t as unknown as (key: string) => string, [t]);
    return useMemo(
        () => DEFAULT_PAGE_ORDER[tab].map((id) => ({ id, label: tAny(pageMeta(id).labelKey), icon: ICONS[id] })),
        [tab, tAny],
    );
}

/** The Profile tab: the Profile page alone (owner: Profile is its own tab again). */
export function ProfilePages() {
    const pills = usePills('profile');
    const renderPage = useCallback(
        ({ active, header }: PageRenderProps) => <ProfileHub header={header} active={active} />,
        [],
    );
    return <TabPages tab="profile" pages={pills} renderPage={renderPage} testID="profile-pages" />;
}

/**
 * The Settings tab (the `you` folder, named before Profile left it): the
 * Settings page alone. The page to open (an old /settings link) arrives
 * through `navigateToPage`'s one-shot request, never a URL param.
 */
export function YouPages() {
    const pills = usePills('you');
    const renderPage = useCallback(({ header }: PageRenderProps) => <SettingsPage header={header} />, []);
    return <TabPages tab="you" pages={pills} renderPage={renderPage} testID="you-pages" />;
}
