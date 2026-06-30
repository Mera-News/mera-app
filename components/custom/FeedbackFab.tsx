import { showFeedback } from '@/lib/feedback';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Floating "Report a Bug" button shown across the main tabs. Opens Sentry's
 * built-in User Feedback widget. Mirrors ScrollToTopFab (same size/offset/look)
 * but pinned bottom-LEFT so the two sit inline as a matched pair.
 */
const FeedbackFab: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    return (
        <Pressable
            onPress={showFeedback}
            accessibilityLabel={t('feedback.fabLabel')}
            accessibilityRole="button"
            style={[styles.fab, { bottom: 20 + insets.bottom }]}
        >
            <MaterialIcons name="bug-report" size={24} color="#000000" />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    fab: {
        position: 'absolute',
        left: 20,
        width: 50,
        height: 50,
        borderRadius: 25,
        backgroundColor: 'rgba(255, 255, 255, 0.9)', // soft white — matches ScrollToTopFab
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 8, // Android shadow
    },
});

export default FeedbackFab;
