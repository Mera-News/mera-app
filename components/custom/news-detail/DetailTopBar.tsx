import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface DetailTopBarProps {
    onBack: () => void;
    /** 'home' on a deep-linked screen with no history behind it. */
    backIcon?: 'back' | 'home';
}

/**
 * The detail screens' floating back control, in ONE place so every state of
 * those screens renders it: loaded, loading, offline, error. The loading
 * branches used to render only a spinner, so on a slow network (the by-id
 * query aborts at 30s) the reader had no visible way back.
 *
 * Positioned absolutely at the safe-area top, above the status-bar scrim
 * (zIndex 5) and the content.
 */
const DetailTopBar: React.FC<DetailTopBarProps> = ({ onBack, backIcon = 'back' }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    return (
        <Box
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}
        >
            <Pressable
                testID="detail-back"
                onPress={onBack}
                accessibilityRole="button"
                accessibilityLabel={t(backIcon === 'home' ? 'common.home' : 'common.back')}
                className="bg-gray-900 rounded-full p-3 shadow-hard-2"
            >
                <MaterialIcons
                    name={backIcon === 'home' ? 'home' : 'arrow-back'}
                    size={24}
                    color="#ffffff"
                />
            </Pressable>
        </Box>
    );
};

export default DetailTopBar;
