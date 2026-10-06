import AppPreferencesTab from '@/components/custom/config-mera/AppPreferencesTab';
import { pageMeta } from '@/components/custom/nav/page-registry';
import TabPages from '@/components/custom/nav/TabPages';
import type { ArrangeConfig, PageHeaderBinding, PagePill, PageRenderProps } from '@/components/custom/nav/types';
import { setPageOrder, usePageOrder } from '@/lib/navigation/page-order';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Animated from 'react-native-reanimated';
import ProfileHub from './ProfileHub';

const ARRANGE: ArrangeConfig = {
    onSave: (draft) => setPageOrder('you', draft.order),
};

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
            contentContainerStyle={{ paddingTop: header.headerHeight + 8, paddingBottom: bottom + 24 }}
        >
            <AppPreferencesTab />
        </Animated.ScrollView>
    );
};

/**
 * The You tab: Profile and Settings, in the reader's order. The page to open
 * (a quick-settings jump, an old /settings link) arrives through
 * `navigateToPage`'s one-shot request, never a URL param.
 */
export function YouPages() {
    const { t } = useTranslation();
    // Registry label keys are computed, so they go through an untyped t.
    const tAny = useMemo(() => t as unknown as (key: string) => string, [t]);
    const order = usePageOrder('you');

    const pills: PagePill[] = useMemo(
        () => order.map((id) => ({ id, label: tAny(pageMeta(id).labelKey) })),
        [order, tAny],
    );

    const renderPage = useCallback(({ pageId, active, header }: PageRenderProps) => {
        switch (pageId) {
            case 'profile':
                return <ProfileHub header={header} active={active} />;
            case 'settings':
                return <SettingsPage header={header} />;
            default:
                return null;
        }
    }, []);

    return <TabPages tab="you" pages={pills} renderPage={renderPage} trailing="bell" arrange={ARRANGE} testID="you-pages" />;
}

export default YouPages;
