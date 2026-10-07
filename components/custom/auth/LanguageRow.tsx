import { MaterialIcons } from '@expo/vector-icons';
import React, { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import MeraLogo from '@/components/custom/MeraLogo';
import { useColors } from '@/lib/theme/tokens';

export type LanguageRowAccessory = 'none' | 'download' | 'busy';

export interface LanguageRowProps {
    /** The language in itself ("Nederlands"). */
    endonym: string;
    /** Its English name ("Dutch"); hidden when it equals the endonym. */
    english: string;
    /** Show the "Your phone's language" line instead of the English name. */
    isPhoneLanguage: boolean;
    picked: boolean;
    /** 'download': this phone still needs the pack. 'busy': getting it ready. */
    accessory: LanguageRowAccessory;
    onPress: () => void;
    onDownload?: () => void;
    /** "Download {{language}}", already filled. */
    downloadA11yLabel: string;
    /** "Your phone's language". */
    phoneLanguageLabel: string;
    testID?: string;
}

/**
 * One row of the first-launch language list (Journey #4, #10): the language as
 * it calls itself, its English name or "Your phone's language", a tick when
 * picked, and on the end a download button or, while it gets ready, the moving
 * Mera mark. The download button is a SIBLING of the row's press area, never
 * nested in it, so a screen reader or a tap on it never selects the row.
 */
export const LanguageRow = memo(function LanguageRow({
    endonym,
    english,
    isPhoneLanguage,
    picked,
    accessory,
    onPress,
    onDownload,
    downloadA11yLabel,
    phoneLanguageLabel,
    testID,
}: LanguageRowProps) {
    const colors = useColors();
    const sub = isPhoneLanguage ? phoneLanguageLabel : english !== endonym ? english : null;
    return (
        <View style={[styles.row, picked && { backgroundColor: PICKED_FILL }]}>
            <Pressable
                onPress={onPress}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked }}
                accessibilityLabel={sub ? `${endonym}, ${sub}` : endonym}
                testID={testID}
                style={styles.main}
            >
                <Text style={[styles.endonym, { color: colors.ink }]}>{endonym}</Text>
                {sub ? <Text style={[styles.sub, { color: colors.ink3 }]}>{sub}</Text> : null}
            </Pressable>
            {/* The trailing mark sits 14pt from the end. The download button is
                a SIBLING of the row's press area (painted over it), never
                nested in it. */}
            {accessory === 'download' ? (
                <Pressable
                    onPress={onDownload}
                    accessibilityRole="button"
                    accessibilityLabel={downloadA11yLabel}
                    testID={testID ? `${testID}-download` : undefined}
                    style={styles.accessory}
                >
                    <View style={styles.downloadDisc}>
                        <MaterialIcons name="file-download" size={18} color={colors.ink2} />
                    </View>
                </Pressable>
            ) : accessory === 'busy' ? (
                <View style={styles.accessory} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <MeraLogo size={20} animated />
                </View>
            ) : picked ? (
                <View style={styles.accessory} pointerEvents="none">
                    <MaterialIcons name="check" size={20} color={colors.accentMark} />
                </View>
            ) : null}
        </View>
    );
});

/** The picked row (FinalJourney #4): the accent at 14%. */
const PICKED_FILL = 'rgba(231,138,83,0.14)';

const styles = StyleSheet.create({
    row: { minHeight: 52, borderRadius: 12, justifyContent: 'center' },
    main: { minHeight: 52, paddingHorizontal: 60, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', gap: 2 },
    endonym: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
    sub: { fontSize: 13, textAlign: 'center' },
    // 44pt hit area whose centre sits 14 + 17pt from the end edge.
    accessory: {
        position: 'absolute',
        end: 14 - (44 - 34) / 2,
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    downloadDisc: {
        width: 34,
        height: 34,
        borderRadius: 17,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
        alignItems: 'center',
        justifyContent: 'center',
    },
});
