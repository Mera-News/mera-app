// The publication's four tags, a 2x2 grid of equal toggles right under its
// identity (FinalLibrary #14 plus the owner's tags): More from | Fewer from,
// then Subscribed | Mute. More, Fewer and Mute write the same
// `publication_preferences` rows as You > Sources and exclude each other:
// tapping the active one clears it back to 'none', tapping another switches
// directly. Subscribed is its own table and combines with any of them.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { SourcePrefUiLevel } from '@/lib/database/services/publication-pref-ui-actions';
import { useColors } from '@/lib/theme/tokens';
import type { PublicationPrefChoice } from './publication-data';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/** Every size here. 38pt buttons in a 44pt frame, given back by margins. */
export const FEED_CONTROL_METRICS = {
    button: 38,
    target: 44,
    gap: 8,
    icon: 15,
    labelLine: 18,
} as const;

const FRAME_PAD = (FEED_CONTROL_METRICS.target - FEED_CONTROL_METRICS.button) / 2;

interface PublicationFeedControlProps {
    readonly current: SourcePrefUiLevel;
    /** A mute on the publication: Mute shows selected, Fewer does not. */
    readonly muted: boolean;
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
    readonly icon: 'arrow-upward' | 'arrow-downward' | 'block' | 'check';
    readonly label: string;
    readonly a11yLabel: string;
    readonly selected: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
}

/** The visual is hidden under a childless labelled button: an icon-font glyph
 *  inside a labelled pressable still surfaces on iOS as its own StaticText. */
const Choice: React.FC<ChoiceProps> = ({ testID, icon, label, a11yLabel, selected, busy, onPress }) => {
    const c = useColors();
    const ink = selected ? c.accentText : c.ink;
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
                <MaterialIcons name={icon} size={FEED_CONTROL_METRICS.icon} color={ink} />
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
                accessibilityState={{ selected, disabled: busy }}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

const PublicationFeedControl: React.FC<PublicationFeedControlProps> = ({
    current,
    muted,
    subscribed,
    canSubscribe,
    subscribeBusy = false,
    onToggleSubscribed,
    busy = false,
    onChange,
    testID,
}) => {
    const { t } = useTranslation();
    const more = current === 'prioritised';
    // The level reads a mute as fewer; here they are separate choices.
    const fewer = current === 'deprioritised' && !muted;
    const pressMore = useCallback(() => onChange(more ? 'none' : 'prioritised'), [more, onChange]);
    const pressFewer = useCallback(() => onChange(fewer ? 'none' : 'deprioritised'), [fewer, onChange]);
    const pressMute = useCallback(() => onChange(muted ? 'none' : 'muted'), [muted, onChange]);

    return (
        <View testID={testID} style={styles.grid}>
            <View style={styles.row}>
                <Choice
                    testID="publication-pref-up"
                    icon="arrow-upward"
                    label={t('publicationPage.moreFrom')}
                    a11yLabel={t('publicationPage.prefMoreA11y')}
                    selected={more}
                    busy={busy}
                    onPress={pressMore}
                />
                <Choice
                    testID="publication-pref-down"
                    icon="arrow-downward"
                    label={t('publicationPage.fewerFrom')}
                    a11yLabel={t('publicationPage.prefFewerA11y')}
                    selected={fewer}
                    busy={busy}
                    onPress={pressFewer}
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
                <Choice
                    testID="publication-pref-mute"
                    icon="block"
                    label={t('you.sources.mute')}
                    a11yLabel={t('you.sources.mute')}
                    selected={muted}
                    busy={busy}
                    onPress={pressMute}
                />
            </View>
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
