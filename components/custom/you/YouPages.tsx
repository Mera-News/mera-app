import AppPreferencesTab from '@/components/custom/config-mera/AppPreferencesTab';
import { PAGE_CONTENT_GAP, pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { PageDot, PageHeaderBinding, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import NotificationsScreen from '@/components/custom/notifications/NotificationsScreen';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import { DEFAULT_PAGE_ORDER } from '@/lib/navigation/page-order';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import ProfileHub from './ProfileHub';

/** You > Settings: app settings only, plan card first. No Mera button here,
 *  so the list ends above the tab bar, not above the button. */
const SettingsPage: React.FC<{ readonly header: PageHeaderBinding }> = ({ header }) => {
    const bottom = useTabBarClearance();
    return (
        <Animated.ScrollView
            testID="settings-page"
            onScroll={header.scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingTop: header.headerHeight + PAGE_CONTENT_GAP, paddingBottom: bottom + 24 }}
        >
            <AppPreferencesTab />
        </Animated.ScrollView>
    );
};

/** Each page's icon on the track (outline MaterialIcons on both platforms). */
const ICONS: Readonly<Record<string, NonNullable<PagePill['icon']>>> = {
    profile: 'person-outline',
    settings: 'settings',
    notifications: 'notifications-none',
};

/** The Notifications pill's dot: lit while anything is unread. Seeing the
 *  page marks rows read, which clears it (and the You tab dot). */
function useNotificationsDot(): PageDot {
    const [visible, setVisible] = useState(false);
    useEffect(() => {
        const sub = observeUnreadCount().subscribe((n) => setVisible(n > 0));
        return () => sub.unsubscribe();
    }, []);
    return { visible };
}

/**
 * The You tab: Profile, Settings and Notifications, a fixed group. Only World
 * is arranged, so a stored `nav_order_you` is never read here. The page to
 * open (an old /settings link) arrives through `navigateToPage`'s one-shot
 * request, never a URL param.
 */
export function YouPages() {
    const { t } = useTranslation();
    // Registry label keys are computed, so they go through an untyped t.
    const tAny = useMemo(() => t as unknown as (key: string) => string, [t]);

    const pills: PagePill[] = useMemo(
        () =>
            DEFAULT_PAGE_ORDER.you.map((id) => ({
                id,
                label: tAny(pageMeta(id).labelKey),
                icon: ICONS[id],
                useDot: id === 'notifications' ? useNotificationsDot : undefined,
            })),
        [tAny],
    );

    const renderPage = useCallback(({ pageId, active, header }: PageRenderProps) => {
        switch (pageId) {
            case 'profile':
                return <ProfileHub header={header} active={active} />;
            case 'settings':
                return <SettingsPage header={header} />;
            case 'notifications':
                return <NotificationsScreen header={header} active={active} />;
            default:
                return null;
        }
    }, []);

    return <TabPages tab="you" pages={pills} renderPage={renderPage} testID="you-pages" />;
}

export default YouPages;
