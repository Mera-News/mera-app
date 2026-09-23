import { GLASS_OVER_CONTENT_FILL, GlassPlate } from '@/components/custom/GlassSurface';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

interface ShareStatsFabProps {
    readonly onPress: () => void;
}

const FAB_RADIUS = 25;

/**
 * Opens the reading-statistics share screen, floating over the Dashboard's
 * History list.
 *
 * ## Why it floats instead of sitting in a row
 *
 * The row version wrapped itself in `paddingTop: headerHeight` so it would
 * clear the collapsing header, and `VisitedPublicationsList` pads by
 * `headerHeight` as well. Two offsets for one header left a screen-tall gap
 * between the sub-tab row and the first publication. Floating removes the
 * wrapper entirely, so the list keeps the only header padding there is.
 *
 * ## Geometry copied from ScrollToTopFab on purpose
 *
 * Right 20, bottom 20 above `useTabBarClearance()`, 50 square, the same glass
 * plate and the same shadow. Two floating buttons in one app that sit at
 * different heights read as a mistake. The clearance comes from the helper and
 * never from `insets.bottom + TAB_BAR_HEIGHT`: inside a tab on iOS the inset
 * already includes the bar, and adding it again floated this button 70pt above
 * the bar.
 *
 * ## A solid base under the glass
 *
 * The glass plate alone could paint nothing on a settled screen, which left a
 * bare arrow floating over the list. The dark base under it is the button's
 * real surface; the glass on top only tints it.
 *
 * The two never appear together: ScrollToTopFab is mounted by `FactFeedScreen`,
 * which is the Fact checks sub-tab. If a future screen wants both, they have to
 * stack rather than overlap, and that is a decision to make deliberately.
 *
 * ## The radius is on the plate, not on this Pressable
 *
 * React Native drops a view's shadow the moment that same view sets
 * `overflow: hidden`, and the shadow is what lifts the button off the list.
 * Same reason ScrollToTopFab does it that way.
 */
const ShareStatsFab: React.FC<ShareStatsFabProps> = ({ onPress }) => {
    const clearance = useTabBarClearance();
    const { t } = useTranslation();

    return (
        <Pressable
            testID="dashboard-history-share"
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('shareStats.entryA11y')}
            style={[styles.fab, { bottom: 20 + clearance }]}
        >
            <View
                testID="dashboard-history-share-base"
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.base]}
            />
            <GlassPlate style={{ borderRadius: FAB_RADIUS }} />
            <MaterialIcons name="ios-share" size={24} color="#e5e7eb" />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: 20,
        width: 50,
        height: 50,
        borderRadius: FAB_RADIUS,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 8,
    },
    base: {
        borderRadius: FAB_RADIUS,
        backgroundColor: GLASS_OVER_CONTENT_FILL,
    },
});

export default ShareStatsFab;
