// The publication's controls under its identity: Preferred and Not preferred
// on row one, Subscribed full width on row two. Preferred and Not preferred
// write the same `publication_preferences` rows as You > Sources and exclude
// each other: tapping the active one clears it back to 'none'. A star that is
// inherited from a preferred country is grey, selected and opens help.
// Subscribed is its own table and combines with either.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import type { PublicationPrefChoice } from './publication-data';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/** Every size here. 38pt buttons in a 44pt frame, given back by margins. */
const FEED_CONTROL_METRICS = {
    button: 38,
    target: 44,
    gap: 8,
    icon: 15,
    labelLine: 18,
} as const;

const FRAME_PAD = (FEED_CONTROL_METRICS.target - FEED_CONTROL_METRICS.button) / 2;

interface PublicationFeedControlProps {
    readonly current: PublicationPrefChoice;
    readonly muted: boolean;
    /** The country the star comes from: grey, selected, opens help, writes nothing. */
    readonly inheritedFrom?: string | null;
    readonly onInheritedPress?: () => void;
    /** The publication's name, for the buttons' spoken labels. */
    readonly displayName?: string;
    readonly subscribed: boolean;
    /** False without a publisher id: a subscription is keyed on one. */
    readonly canSubscribe: boolean;
    readonly subscribeBusy?: boolean;
    readonly onToggleSubscribed: () => void;
    readonly busy?: boolean;
    /** Called with the NEXT level. */
    readonly onChange: (next: PublicationPrefChoice) => void;
    readonly testID?: string;
}

interface ChoiceProps {
    readonly testID: string;
    readonly icon: 'star' | 'star-border' | 'eye-off' | 'eye-off-outline' | 'check';
    readonly label: string;
    readonly a11yLabel: string;
    readonly a11yHint?: string;
    /** Overrides the ink, such as the inherited grey star. */
    readonly tint?: string;
    readonly selected: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
}

/** The visual is hidden under a childless labelled button: an icon-font glyph
 *  inside a labelled pressable still surfaces on iOS as its own StaticText. */
const Choice: React.FC<ChoiceProps> = ({ testID, icon, label, a11yLabel, a11yHint, tint, selected, busy, onPress }) => {
    const c = useColors();
    const ink = tint ?? (selected ? c.accentText : c.ink);
    const Icon = icon === 'eye-off' || icon === 'eye-off-outline' ? MaterialCommunityIcons : MaterialIcons;
    return (
        <View testID={`${testID}-frame`} style={[styles.frame, { opacity: busy ? 0.5 : 1 }]}>
            <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                    styles.button,
                    {
                        borderColor: selected ? c.accentMark : c.line,
                        backgroundColor: selected ? c.surfaceRaised : c.surface,
                    },
                ]}
            >
                <Icon name={icon as never} size={FEED_CONTROL_METRICS.icon} color={ink} />
                <Text size="sm" numberOfLines={1} style={{ color: ink, fontWeight: '600', lineHeight: FEED_CONTROL_METRICS.labelLine }}>
                    {label}
                </Text>
            </View>
            <Pressable
                testID={testID}
                onPress={onPress}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={a11yLabel}
                accessibilityHint={a11yHint}
                accessibilityState={{ selected, disabled: busy }}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

const PublicationFeedControl: React.FC<PublicationFeedControlProps> = ({
    current,
    muted,
    inheritedFrom = null,
    onInheritedPress,
    displayName = '',
    subscribed,
    canSubscribe,
    subscribeBusy = false,
    onToggleSubscribed,
    busy = false,
    onChange,
    testID,
}) => {
    const { t } = useTranslation();
    const c = useColors();
    const preferred = current === 'prioritised';
    const pressUp = useCallback(() => {
        if (inheritedFrom) onInheritedPress?.();
        else onChange(preferred ? 'none' : 'prioritised');
    }, [inheritedFrom, onInheritedPress, preferred, onChange]);
    const pressMute = useCallback(() => onChange(muted ? 'none' : 'muted'), [muted, onChange]);

    return (
        <View testID={testID} style={styles.grid}>
            <View style={styles.row}>
                <Choice
                    testID="publication-pref-up"
                    icon={preferred || inheritedFrom ? 'star' : 'star-border'}
                    label={t('publicationPage.preferred')}
                    a11yLabel={
                        inheritedFrom
                            ? t('publicationPage.includedWithA11y', { country: inheritedFrom })
                            : t('publicationPage.preferA11y', { publisher: displayName })
                    }
                    tint={inheritedFrom ? c.ink3 : undefined}
                    selected={preferred || !!inheritedFrom}
                    busy={busy}
                    onPress={pressUp}
                />
                <Choice
                    testID="publication-pref-mute"
                    icon={muted ? 'eye-off' : 'eye-off-outline'}
                    label={t('publicationPage.notPreferred')}
                    a11yLabel={t('publicationPage.notPreferA11y', { publisher: displayName })}
                    a11yHint={t('publicationPage.notPreferHint')}
                    selected={muted}
                    busy={busy}
                    onPress={pressMute}
                />
            </View>
            <View style={styles.row}>
                <Choice
                    testID="publication-pref-subscribed"
                    icon="check"
                    label={t('publicationPage.subscribed')}
                    a11yLabel={t('publicationPage.subscribed')}
                    selected={subscribed}
                    busy={subscribeBusy || !canSubscribe}
                    onPress={onToggleSubscribed}
                />
            </View>
            {inheritedFrom ? (
                <Text size="xs" style={{ color: c.ink3 }}>
                    {t('publicationPage.includedWith', { country: inheritedFrom })}
                </Text>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    grid: { rowGap: FEED_CONTROL_METRICS.gap },
    row: { flexDirection: 'row', columnGap: FEED_CONTROL_METRICS.gap },
    frame: { flex: 1, paddingVertical: FRAME_PAD, marginVertical: -FRAME_PAD },
    button: {
        minHeight: FEED_CONTROL_METRICS.button,
        borderRadius: 12,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingHorizontal: 10,
    },
});

export default PublicationFeedControl;
