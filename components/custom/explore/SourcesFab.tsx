import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface SourcesFabProps {
    readonly onPress: () => void;
}

/**
 * Floating Sources action for the Explore tab. Positioned bottom-right above the
 * tab bar (ScrollToTopFab precedent). The floating Mera chat bubble stays
 * visible on Explore, but its bottom clamp keeps it well above this band, so
 * bottom-right does not collide with it (see ExploreScreen note).
 */
const SourcesFab: React.FC<SourcesFabProps> = ({ onPress }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={t('explore.sources')}
            style={[styles.fab, { bottom: 20 + insets.bottom + TAB_BAR_HEIGHT }]}
        >
            <MaterialIcons name="rss-feed" size={26} color="#000000" />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: ACCENT,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 8,
    },
});

export default SourcesFab;
