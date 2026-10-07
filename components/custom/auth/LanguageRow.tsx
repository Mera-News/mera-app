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
        <View style={[styles.row, picked && { backgroundColor: colors.surfaceRaised }]}>
            <Pressable
                onPress={onPress}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked }}
                accessibilityLabel={sub ? `${endonym}, ${sub}` : endonym}
                testID={testID}
                style={styles.main}
            >
                <View style={styles.names}>
                    <Text style={[styles.endonym, { color: colors.ink }]}>{endonym}</Text>
                    {sub ? <Text style={[styles.sub, { color: colors.ink3 }]}>{sub}</Text> : null}
                </View>
                {picked ? <MaterialIcons name="check" size={20} color={colors.accentMark} /> : null}
            </Pressable>
            {accessory === 'download' ? (
                <Pressable
                    onPress={onDownload}
                    accessibilityRole="button"
                    accessibilityLabel={downloadA11yLabel}
                    testID={testID ? `${testID}-download` : undefined}
                    style={styles.accessory}
                >
                    <View style={[styles.downloadDisc, { borderColor: colors.line }]}>
                        <MaterialIcons name="file-download" size={18} color={colors.ink2} />
                    </View>
                </Pressable>
            ) : accessory === 'busy' ? (
                <View style={styles.accessory} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <MeraLogo size={20} animated />
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderRadius: 12 },
    main: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 16, gap: 12 },
    names: { flex: 1, gap: 2 },
    endonym: { fontSize: 16, fontWeight: '600' },
    sub: { fontSize: 13 },
    accessory: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginEnd: 6 },
    downloadDisc: {
        width: 32,
        height: 32,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
