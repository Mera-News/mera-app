import { GLASS_OVER_CONTENT_FILL, TranslucentPlate } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The back button's offset below the safe-area top. */
export const DETAIL_BACK_TOP_OFFSET = 8;
/** The back button: `p-3` around a 24pt icon. */
export const DETAIL_BACK_SIZE = 48;
/** The bar's height below the safe-area top: the button plus the same gap
 *  under it as above. Content scrolled past this line is under the bar. */
export const DETAIL_TOP_BAR_HEIGHT = DETAIL_BACK_TOP_OFFSET + DETAIL_BACK_SIZE + DETAIL_BACK_TOP_OFFSET;
/** Fade of the plate, both ways. */
export const DETAIL_TOP_BAR_FADE_MS = 150;

export interface DetailTopBarProps {
    onBack: () => void;
    /** 'home' on a deep-linked screen with no history behind it. */
    backIcon?: 'back' | 'home';
    /** M8/F31: content has scrolled under the bar, so a solid plate fades in
     *  behind the button. Without it the floating button sat on top of the
     *  meta row ("1d ago") once the reader scrolled. */
    solid?: boolean;
}

/**
 * The detail screens' floating back control, in ONE place so every state of
 * those screens renders it: loaded, loading, offline, error. The loading
 * branches used to render only a spinner, so on a slow network (the by-id
 * query aborts at 30s) the reader had no visible way back.
 *
 * Positioned absolutely at the safe-area top, above the status-bar scrim
 * (zIndex 5) and the content. When `solid`, a full-width plate (the dark
 * over-content base plus the translucent plate, as every surface over content
 * carries) fades in behind it, from the screen top to under the button.
 */
const DetailTopBar: React.FC<DetailTopBarProps> = ({ onBack, backIcon = 'back', solid = false }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const plateOpacity = useRef(new Animated.Value(solid ? 1 : 0)).current;
    useEffect(() => {
        Animated.timing(plateOpacity, {
            toValue: solid ? 1 : 0,
            duration: DETAIL_TOP_BAR_FADE_MS,
            useNativeDriver: true,
        }).start();
    }, [solid, plateOpacity]);

    return (
        <>
            <Animated.View
                testID="detail-top-plate"
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: 0,
                    height: insets.top + DETAIL_TOP_BAR_HEIGHT,
                    zIndex: 19,
                    opacity: plateOpacity,
                    overflow: 'hidden',
                    backgroundColor: GLASS_OVER_CONTENT_FILL,
                }}
            >
                <TranslucentPlate />
            </Animated.View>
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
        </>
    );
};

export default DetailTopBar;
