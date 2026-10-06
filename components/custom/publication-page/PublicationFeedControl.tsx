import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { SourcePrefUiLevel } from '@/lib/database/services/publication-pref-ui-actions';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/** Every size here. The pill is drawn at `pill` and its tap frame is padded
 *  out to `target`, given back by a negative margin so the row keeps the
 *  pill's visual rhythm (same trick as the Dashboard pills). */
export const FEED_CONTROL_METRICS = {
    pill: 32,
    target: 44,
    gap: 8,
    icon: 15,
    labelLine: 18,
} as const;

const FRAME_PAD = (FEED_CONTROL_METRICS.target - FEED_CONTROL_METRICS.pill) / 2;

const BOOST = '#10b981';
const DOWNRANK = '#f59e0b';
const IDLE_BORDER = 'rgba(255,255,255,0.16)';
const IDLE_INK = 'rgb(209,213,219)';
const LABEL_INK = 'rgb(156,163,175)';

interface PublicationFeedControlProps {
    readonly current: SourcePrefUiLevel;
    readonly busy?: boolean;
    /** Called with the NEXT level: tapping the active choice clears it back
     *  to 'none', tapping the other switches directly (one rule, so every
     *  surface behaves the same). */
    readonly onChange: (next: SourcePrefUiLevel) => void;
    readonly testID?: string;
}

interface ChoiceProps {
    readonly testID: string;
    readonly icon: 'arrow-upward' | 'arrow-downward';
    readonly label: string;
    readonly a11yLabel: string;
    readonly selected: boolean;
    readonly tint: string;
    readonly busy: boolean;
    readonly onPress: () => void;
}

/**
 * One choice. The visual (icon + word) is hidden from accessibility and a
 * childless labelled button lies over it: an icon-font glyph inside a labelled
 * pressable still surfaces on iOS as its own StaticText. The frame View holds
 * the 44pt target; `testID` sits on the button, `${testID}-frame` on the frame.
 */
const Choice: React.FC<ChoiceProps> = ({ testID, icon, label, a11yLabel, selected, tint, busy, onPress }) => {
    const ink = selected ? tint : IDLE_INK;
    return (
        <View
            testID={`${testID}-frame`}
            style={{ paddingVertical: FRAME_PAD, marginVertical: -FRAME_PAD, opacity: busy ? 0.5 : 1 }}
        >
            <View
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    minHeight: FEED_CONTROL_METRICS.pill,
                    borderRadius: 999,
                    paddingLeft: 9,
                    paddingRight: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    borderWidth: 1,
                    borderColor: selected ? `${tint}99` : IDLE_BORDER,
                    backgroundColor: selected ? `${tint}24` : 'transparent',
                }}
            >
                <MaterialIcons name={icon} size={FEED_CONTROL_METRICS.icon} color={ink} />
                <Text
                    size="sm"
                    numberOfLines={1}
                    style={{ color: ink, fontWeight: '600', lineHeight: FEED_CONTROL_METRICS.labelLine }}
                >
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

/**
 * "In your feed  [↑ Boost] [↓ Downrank]": the page's more/fewer control, with
 * words instead of bare arrows. The words are Source preferences' own
 * (`publicationPrefs.kindBoost` / `kindDeprioritize`), so the page and that
 * screen name the same setting the same way. The row wraps: in a long locale
 * the two choices move under the label rather than squeezing it.
 */
const PublicationFeedControl: React.FC<PublicationFeedControlProps> = ({ current, busy = false, onChange, testID }) => {
    const { t } = useTranslation();
    const boosted = current === 'prioritised';
    const downranked = current === 'deprioritised';

    const pressBoost = useCallback(() => onChange(boosted ? 'none' : 'prioritised'), [boosted, onChange]);
    const pressDownrank = useCallback(() => onChange(downranked ? 'none' : 'deprioritised'), [downranked, onChange]);

    return (
        <View
            testID={testID}
            style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: FEED_CONTROL_METRICS.gap,
                rowGap: 10,
            }}
        >
            <Text
                size="sm"
                style={{ color: LABEL_INK, lineHeight: FEED_CONTROL_METRICS.labelLine, marginRight: 4 }}
                testID="publication-pref-label"
            >
                {t('freeTier.factsInFeedHeader')}
            </Text>
            <View style={{ flexDirection: 'row', columnGap: FEED_CONTROL_METRICS.gap }}>
                <Choice
                    testID="publication-pref-up"
                    icon="arrow-upward"
                    label={t('publicationPrefs.kindBoost')}
                    a11yLabel={t('publicationPage.prefMoreA11y')}
                    selected={boosted}
                    tint={BOOST}
                    busy={busy}
                    onPress={pressBoost}
                />
                <Choice
                    testID="publication-pref-down"
                    icon="arrow-downward"
                    label={t('publicationPrefs.kindDeprioritize')}
                    a11yLabel={t('publicationPage.prefFewerA11y')}
                    selected={downranked}
                    tint={DOWNRANK}
                    busy={busy}
                    onPress={pressDownrank}
                />
            </View>
        </View>
    );
};

export default PublicationFeedControl;
