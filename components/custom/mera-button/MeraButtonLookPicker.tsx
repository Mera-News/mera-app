// Settings > Display > Mera button: the two looks shown as the button itself
// (a still disc and mark at preview size), a radio pair. The picked one wears
// the same accent ring the button uses for an unread answer, 2pt and a few pt
// outside the disc. Nothing animates here: the marks are still, and a pick
// changes the ring at once.

import MeraLogo from '@/components/custom/MeraLogo';
import { hapticSelection } from '@/lib/haptics';
import { useDisplayPrefsStore, type MeraButtonLook } from '@/lib/stores/display-prefs-store';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { meraButtonColors, useMeraButtonLook } from './look';

const DISC = 52;
/** The logo-to-disc ratio of the real button (38pt mark in a 62pt disc). */
const MARK = Math.round((DISC * 38) / 62);
const RING_GAP = 4;
const RING_WIDTH = 2;
/** The hit area: the ringed disc, never under 44pt. */
const FRAME = DISC + 2 * (RING_GAP + RING_WIDTH);
const LOOKS: readonly MeraButtonLook[] = ['light', 'dark'];

const MeraButtonLookPicker: React.FC<{ readonly groupLabel: string }> = ({ groupLabel }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const current = useMeraButtonLook();
    const setLook = useDisplayPrefsStore((s) => s.setMeraButtonLook);

    return (
        <View
            accessibilityRole="radiogroup"
            accessibilityLabel={groupLabel}
            style={{ flexDirection: 'row', columnGap: 16 }}
            testID="mera-button-look-picker"
        >
            {LOOKS.map((look) => {
                const picked = look === current;
                const { disc, mark } = meraButtonColors(look);
                const label = look === 'light' ? t('display.appearanceLight') : t('display.appearanceDark');
                return (
                    <Pressable
                        key={look}
                        testID={`mera-button-look-${look}`}
                        onPress={() => {
                            if (picked) return;
                            void hapticSelection();
                            setLook(look);
                        }}
                        accessibilityRole="radio"
                        accessibilityLabel={label}
                        accessibilityState={{ checked: picked, selected: picked }}
                        style={{ width: FRAME, height: FRAME, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <View
                            style={{
                                position: 'absolute',
                                width: FRAME,
                                height: FRAME,
                                borderRadius: FRAME / 2,
                                borderWidth: RING_WIDTH,
                                borderColor: picked ? colors.accentMark : 'transparent',
                            }}
                        />
                        <View
                            style={{
                                width: DISC,
                                height: DISC,
                                borderRadius: DISC / 2,
                                backgroundColor: disc,
                                // A light disc on a light page needs its edge.
                                borderWidth: 1,
                                borderColor: colors.line,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <MeraLogo size={MARK} color={mark} animated={false} />
                        </View>
                    </Pressable>
                );
            })}
        </View>
    );
};

export default MeraButtonLookPicker;
