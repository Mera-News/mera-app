import TapPressable from '@/components/custom/cards/TapPressable';
import { HelpModal } from '@/components/ui/help-modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { useColors } from '@/lib/theme/tokens';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const CONTROL = 44;
const ICON = 22;
const PRESSED_OPACITY = 0.6;
const PRESS_DELAY_MS = 130;

/** The visual is hidden under a childless labelled button: an icon-font glyph
 *  inside a labelled pressable still surfaces on iOS as its own StaticText. */
const RowControl: React.FC<{
    readonly testID: string;
    readonly label: string;
    readonly hint?: string;
    readonly selected: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
    readonly children: React.ReactNode;
}> = ({ testID, label, hint, selected, busy, onPress, children }) => (
    <View testID={`${testID}-frame`} style={[styles.control, { opacity: busy ? 0.5 : 1 }]}>
        <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {children}
        </View>
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={hint}
            accessibilityState={{ selected, disabled: busy }}
            style={StyleSheet.absoluteFill}
        />
    </View>
);

interface PublicationControlRowProps {
    /** The RAW name; the row shows its display form. */
    readonly rawName: string;
    readonly flag?: string | null;
    readonly subtitle?: string | null;
    /** With `onStar`. */
    readonly starred?: boolean;
    /** The country the star comes from: grey, opens help, never toggles. */
    readonly inheritedFrom?: string | null;
    readonly notPreferred?: boolean;
    readonly busy?: boolean;
    /** A publication's two controls. */
    readonly onStar?: (shownAs: string) => void;
    readonly onNotPreferred?: (shownAs: string) => void;
    /** Instead of those: a stored country row, which only comes off. */
    readonly onRemove?: (shownAs: string) => void;
    /** Absent: the body is plain text, not a button (onboarding). */
    readonly onPress?: () => void;
    /** Under the row, such as onboarding's "I subscribe". */
    readonly footer?: React.ReactNode;
    readonly testID: string;
}

/**
 * The source row Sources and onboarding share: a body that opens the page, and
 * star and Not preferred as SIBLINGS of that body, because VoiceOver cannot
 * reach a button nested in a row.
 */
const PublicationControlRow: React.FC<PublicationControlRowProps> = ({
    rawName,
    flag,
    subtitle,
    starred = false,
    inheritedFrom,
    notPreferred,
    busy = false,
    onStar,
    onNotPreferred,
    onRemove,
    onPress,
    footer,
    testID,
}) => {
    const { t } = useTranslation();
    const c = useColors();
    const shown = useDisplayPublication(rawName.trim()) || rawName;
    const [pressed, setPressed] = useState(false);
    const line = inheritedFrom ? t('publicationPage.includedWith', { country: inheritedFrom }) : subtitle;
    const bodyLabel = [shown, line].filter(Boolean).join(', ');
    const starLabel = inheritedFrom
        ? t('publicationPage.includedWithA11y', { country: inheritedFrom })
        : t('publicationPage.preferA11y', { publisher: shown });

    const visual = (
        <View
            style={[styles.body, pressed ? { opacity: PRESSED_OPACITY } : undefined]}
            accessible={false}
            accessibilityElementsHidden={!!onPress}
            importantForAccessibility={onPress ? 'no-hide-descendants' : 'auto'}
        >
            {flag ? <Text className="text-2xl">{flag}</Text> : null}
            <View style={styles.text}>
                <Text className="text-base text-ink" numberOfLines={2}>
                    {shown}
                </Text>
                {line ? (
                    <Text size="xs" className="text-ink-3" numberOfLines={2}>
                        {line}
                    </Text>
                ) : null}
            </View>
        </View>
    );

    return (
        <View className="mx-4 mb-3 rounded-lg border border-line" testID={`${testID}-frame`}>
            <View style={styles.row}>
                {onPress ? (
                    <View style={styles.flex}>
                        {visual}
                        <TapPressable
                            testID={testID}
                            onPress={onPress}
                            unstable_pressDelay={PRESS_DELAY_MS}
                            onPressIn={() => setPressed(true)}
                            onPressOut={() => setPressed(false)}
                            accessibilityRole="button"
                            accessibilityLabel={bodyLabel}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                ) : (
                    <View testID={`${testID}-body`} accessible accessibilityLabel={bodyLabel} style={styles.flex}>
                        {visual}
                    </View>
                )}
                {onStar ? (
                    <RowControl
                        testID={`${testID}-star`}
                        label={starLabel}
                        selected={starred || !!inheritedFrom}
                        busy={busy}
                        onPress={() => onStar(shown)}
                    >
                        <MaterialIcons
                            name={starred || inheritedFrom ? 'star' : 'star-border'}
                            size={ICON}
                            color={inheritedFrom ? c.ink3 : starred ? c.accent : c.ink2}
                        />
                    </RowControl>
                ) : null}
                {onNotPreferred ? (
                    <RowControl
                        testID={`${testID}-hide`}
                        label={t('publicationPage.notPreferA11y', { publisher: shown })}
                        hint={t('publicationPage.notPreferHint')}
                        selected={!!notPreferred}
                        busy={busy}
                        onPress={() => onNotPreferred(shown)}
                    >
                        <MaterialCommunityIcons
                            name={notPreferred ? 'eye-off' : 'eye-off-outline'}
                            size={ICON}
                            color={notPreferred ? c.negative : c.ink2}
                        />
                    </RowControl>
                ) : null}
                {onRemove ? (
                    <RowControl
                        testID={`${testID}-remove`}
                        label={t('you.fact.places.remove', { place: shown })}
                        selected={false}
                        busy={busy}
                        onPress={() => onRemove(shown)}
                    >
                        <MaterialIcons name="close" size={ICON} color={c.ink2} />
                    </RowControl>
                ) : null}
            </View>
            {footer}
        </View>
    );
};

/** One per list: what a tap on an inherited star opens. */
export const InheritedStarHelp: React.FC<{
    readonly country: string | null;
    readonly onClose: () => void;
}> = ({ country, onClose }) => {
    const { t } = useTranslation();
    // Keeps the words while the card animates out.
    const [shown, setShown] = useState(country);
    if (country && country !== shown) setShown(country);
    return (
        <HelpModal open={!!country} onClose={onClose} title={t('publicationPage.preferred')} testID="inherited-star-help">
            <Text className="text-ink">{t('publicationPage.includedWithHelp', { country: shown ?? '' })}</Text>
        </HelpModal>
    );
};

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
    flex: { flex: 1 },
    body: { flexDirection: 'row', alignItems: 'center', columnGap: 12, paddingLeft: 16, paddingRight: 8, paddingVertical: 12 },
    text: { flex: 1, rowGap: 2 },
    control: { width: CONTROL, height: CONTROL, alignItems: 'center', justifyContent: 'center' },
});

export default PublicationControlRow;
