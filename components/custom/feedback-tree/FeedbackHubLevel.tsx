// One level of the v6 feedback sheet (design of record: the fbx canvas): a
// heading, an optional subtitle, the rows on one plate, Tell Mera always the
// last row, and an optional note under the plate. Presentational only: the
// rows, their answered state and what a tap does come from useFeedbackHub.

import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, View, findNodeHandle, type Text as RNText } from 'react-native';

export interface HubRow {
    key: string;
    testID: string;
    label: string;
    /** The full label when `label` clamps the fact (VoiceOver reads this). */
    a11yLabel?: string;
    /** A second line: Tell Mera's hint, or an answered row's answer. */
    subtitle?: string;
    icon: keyof typeof MaterialIcons.glyphMap | 'mera';
    /** Answered: a ✓ in place of the icon, and the answer as subtitle. */
    answered?: boolean;
    opensLevel?: boolean;
    destructive?: boolean;
    onPress: () => void;
}

export interface FeedbackHubLevelProps {
    heading: string;
    headingA11y?: string;
    subtitle?: string;
    subtitleA11y?: string;
    rows: HubRow[];
    note?: string;
    /** Changes when the reader comes back to the root after an answer: the
     *  heading takes VoiceOver focus ("Anything else?"). */
    focusKey?: number;
}

/** Rows hold 60pt and 17pt text (the canvas); the plate is one grouped surface. */
const ROW = { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12 } as const;

const FeedbackHubLevel: React.FC<FeedbackHubLevelProps> = ({
    heading,
    headingA11y,
    subtitle,
    subtitleA11y,
    rows,
    note,
    focusKey,
}) => {
    const c = useColors();
    const headingRef = useRef<RNText>(null);
    useEffect(() => {
        if (!focusKey) return;
        const node = findNodeHandle(headingRef.current);
        if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, [focusKey]);

    return (
        <View style={{ gap: 14, paddingHorizontal: 8 }} testID="feedback-hub-level">
            <View style={{ gap: 2, marginHorizontal: 4 }}>
                <Text
                    ref={headingRef}
                    accessibilityRole="header"
                    accessibilityLabel={headingA11y}
                    testID="feedback-hub-heading"
                    style={{ color: c.ink, fontSize: 22, lineHeight: 30, fontWeight: '700' }}
                >
                    {heading}
                </Text>
                {subtitle ? (
                    <Text
                        numberOfLines={3}
                        accessibilityLabel={subtitleA11y}
                        testID="feedback-hub-subtitle"
                        style={{ color: c.ink2, fontSize: 15, lineHeight: 22 }}
                    >
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            <View
                style={{
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: c.surfaceRaised,
                    overflow: 'hidden',
                }}
            >
                {rows.map((row, i) => (
                    <Pressable
                        key={row.key}
                        testID={row.testID}
                        accessibilityRole="button"
                        accessibilityLabel={
                            (row.a11yLabel ?? row.label) + (row.subtitle ? `, ${row.subtitle}` : '')
                        }
                        onPress={row.onPress}
                    >
                        {/* Layout on an inner View with a STATIC style: a function style on a
                            Pressable is dropped on device. */}
                        <View style={[ROW, i > 0 ? { borderTopWidth: 1, borderTopColor: c.line } : null]}>
                            {row.answered ? (
                                <MaterialIcons name="check-circle" size={24} color={c.accent} />
                            ) : row.icon === 'mera' ? (
                                <MeraLogo size={26} />
                            ) : (
                                <MaterialIcons
                                    name={row.icon}
                                    size={24}
                                    color={row.destructive ? c.negative : c.ink2}
                                />
                            )}
                            <View style={{ flex: 1, gap: 2 }}>
                                <Text
                                    style={{
                                        color: row.destructive ? c.negative : c.ink,
                                        fontSize: 17,
                                        lineHeight: 24,
                                        fontWeight: '500',
                                    }}
                                >
                                    {row.label}
                                </Text>
                                {row.subtitle ? (
                                    <Text style={{ color: c.ink2, fontSize: 14, lineHeight: 20 }}>{row.subtitle}</Text>
                                ) : null}
                            </View>
                            {row.opensLevel ? <MaterialIcons name="chevron-right" size={24} color={c.ink3} /> : null}
                        </View>
                    </Pressable>
                ))}
            </View>
            {note ? (
                <Text testID="feedback-hub-note" style={{ marginHorizontal: 4, color: c.ink2, fontSize: 14, lineHeight: 21 }}>
                    {note}
                </Text>
            ) : null}
        </View>
    );
};

export default FeedbackHubLevel;
