import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DETAIL_BACK_TOP_OFFSET } from '@/components/custom/news-detail/detail-top-bar-metrics';

export { DETAIL_BACK_SIZE, DETAIL_BACK_TOP_OFFSET } from '@/components/custom/news-detail/detail-top-bar-metrics';

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
 * (zIndex 5) and the content, on its OWN dark circle, so it stays legible
 * over a photo or text. There is deliberately NO bar behind it at any scroll
 * position (owner: "earlier in detail page i never saw this dark header. even
 * when scrolled up."): a solid bar that faded in on scroll covered the meta
 * row, and was removed.
 */
const DetailTopBar: React.FC<DetailTopBarProps> = ({ onBack, backIcon = 'back' }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    return (
        <Box
            pointerEvents="box-none"
            style={{ position: 'absolute', left: 8, top: insets.top + DETAIL_BACK_TOP_OFFSET, zIndex: 20 }}
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
