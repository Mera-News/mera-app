import { GLASS_OVER_CONTENT_FILL, GlassPlate } from '@/components/custom/GlassSurface';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SavedExportFabProps {
    readonly onPress: () => void;
    /** True on the Dashboard's Saved sub-tab, false on the standalone route.
     *  See the clearance note below: the two render at different heights and
     *  must, because only one of them has a tab bar behind it. */
    readonly embedded: boolean;
}

/** The FAB's own footprint plus its bottom offset. Exported because the LIST
 *  has to reserve it: every saved card carries its delete button at its own
 *  TOP-right, so without this reserve the button on the last card sits under
 *  the FAB and cannot be pressed. That exact control has been made unpressable
 *  by an overlay on this exact screen once before, by coordinate AND by
 *  accessibility ref, so this is an earned reserve and not padding for looks.
 *  The History FAB needs no equivalent: its rows have no corner control. */
export const SAVED_EXPORT_FAB_RESERVE = 20 + 50 + 12;

const FAB_RADIUS = 25;

/**
 * Opens the export wizard, floating over the Saved list.
 *
 * ## A fourth sibling rather than an abstraction
 *
 * `ShareStatsFab`, `ScrollToTopFab` and the inline one in
 * `TrackedStoriesScreen` are already three near-identical files. Three similar
 * files beat a premature abstraction, and `ShareStatsFab` has a test pinning
 * its exact geometry, so generalising it would mean changing a guard to add a
 * caller. The geometry below is copied deliberately: two floating buttons in
 * one app that sit at different heights read as a mistake.
 *
 * ## Why this one takes `embedded` and ShareStatsFab does not
 *
 * `ShareStatsFab` is only ever mounted by `ForYouScreen`, inside the tab
 * navigator, so it always takes `useTabBarClearance()`. This screen renders in two
 * places: the Dashboard's Saved sub-tab, which sits inside the navigator with
 * the bar drawn behind it, and `/logged-in/saved-suggestions`, a Stack screen
 * pushed OUTSIDE it where no bar renders. Embedded takes `useTabBarClearance()`;
 * standalone takes the plain inset. Never `insets.bottom + TAB_BAR_HEIGHT`
 * inside a tab: on iOS that inset already includes the bar.
 *
 * The dark base under the glass is the button's real surface: the glass plate
 * alone could paint nothing and leave a bare icon over the list.
 *
 * ## The radius is on the plate, not on this Pressable
 *
 * React Native drops a view's shadow the moment that same view sets
 * `overflow: hidden`, and the shadow is what lifts the button off the list.
 */
const SavedExportFab: React.FC<SavedExportFabProps> = ({ onPress, embedded }) => {
    const insets = useSafeAreaInsets();
    const tabClearance = useTabBarClearance();
    const { t } = useTranslation();

    return (
        <Pressable
            testID="saved-export-open"
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('savedExport.fabA11y')}
            style={[
                styles.fab,
                { bottom: 20 + (embedded ? tabClearance : insets.bottom) },
            ]}
        >
            <View
                testID="saved-export-open-base"
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

export default SavedExportFab;
