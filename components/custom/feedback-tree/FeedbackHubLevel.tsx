// One level of the v6 feedback sheet (design of record: the fbx canvas): a
// heading, an optional subtitle, the rows on one plate, Tell Mera always the
// last row, and an optional note under the plate. Presentational only: the
// rows, their answered state and what a tap does come from useFeedbackHub.

import { SHEET } from '@/components/custom/cards/sheet-metrics';
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
    /** What VoiceOver reads, WHOLE when given (the full fact, or "<row>,
     *  answered: <answer>"); absent: the label and subtitle. */
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

/** The ••• sheet's row rhythm (SHEET), on one grouped plate. A row that
 *  wraps (a quoted fact) grows past the 48pt minimum. */
const ROW = {
    minHeight: SHEET.controlHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SHEET.rowIconGap,
    paddingHorizontal: SHEET.rowInset,
    paddingVertical: 10,
} as const;

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
        <View style={{ gap: SHEET.section }} testID="feedback-hub-level">
            <View style={{ gap: 4 }}>
                <Text
                    ref={headingRef}
                    accessibilityRole="header"
                    accessibilityLabel={headingA11y}
                    testID="feedback-hub-heading"
                    style={{ color: c.ink, ...SHEET.title }}
                >
                    {heading}
                </Text>
                {subtitle ? (
                    <Text
                        numberOfLines={3}
                        accessibilityLabel={subtitleA11y}
                        testID="feedback-hub-subtitle"
                        style={{ color: c.ink2, ...SHEET.body }}
                    >
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            <View
                style={{
                    borderRadius: SHEET.radius,
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
                        accessibilityLabel={row.a11yLabel ?? (row.subtitle ? `${row.label}, ${row.subtitle}` : row.label)}
                        onPress={row.onPress}
                    >
                        {/* Layout on an inner View with a STATIC style: a function style on a
                            Pressable is dropped on device. */}
                        <View style={[ROW, i > 0 ? { borderTopWidth: 1, borderTopColor: c.line } : null]}>
                            {row.answered ? (
                                <MaterialIcons name="check-circle" size={SHEET.iconSize} color={c.accent} />
                            ) : row.icon === 'mera' ? (
                                <MeraLogo size={SHEET.iconSize + 2} />
                            ) : (
                                <MaterialIcons
                                    name={row.icon}
                                    size={SHEET.iconSize}
                                    color={row.destructive ? c.negative : c.ink2}
                                />
                            )}
                            <View style={{ flex: 1, gap: 2 }}>
                                <Text
                                    style={{ color: row.destructive ? c.negative : c.ink, ...SHEET.label }}
                                >
                                    {row.label}
                                </Text>
                                {row.subtitle ? (
                                    <Text style={{ color: c.ink3, ...SHEET.caption }}>{row.subtitle}</Text>
                                ) : null}
                            </View>
                            {row.opensLevel ? <MaterialIcons name="chevron-right" size={SHEET.iconSize} color={c.ink} /> : null}
                        </View>
                    </Pressable>
                ))}
            </View>
            {note ? (
                <Text testID="feedback-hub-note" style={{ color: c.ink3, ...SHEET.caption }}>
                    {note}
                </Text>
            ) : null}
        </View>
    );
};

export default FeedbackHubLevel;
