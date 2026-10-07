import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';

export type StepStatus = 'done' | 'open' | 'hidden';

export interface AccordionStep {
    id: string;
    title: string;
    /** Under the title while the step is open. */
    hint?: string;
    /** Under the title once done ("Saved", "iCloud"). */
    summary?: string;
    status: StepStatus;
    /** A done step's way back in ("Show", "Change"). */
    actionLabel?: string;
    onAction?: () => void;
    /** The open step's body: choices, fields, buttons. */
    children?: React.ReactNode;
}

export interface StepsAccordionProps {
    steps: AccordionStep[];
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const LAYOUT = LinearTransition.duration(220);

/**
 * Steps that open one below the other on one card (FinalBackup): the open step
 * shows its number and body, a finished step folds to one line with a tick,
 * its summary and an action that reopens it, and later steps are not drawn.
 * The parent owns every status; this only draws them.
 */
export function StepsAccordion({ steps, style, testID }: StepsAccordionProps) {
    const colors = useColors();
    const reduceMotion = useReducedMotion();
    const visible = steps.filter((s) => s.status !== 'hidden');
    return (
        <Animated.View
            layout={reduceMotion ? undefined : LAYOUT}
            testID={testID}
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }, style]}
        >
            {visible.map((step, i) => {
                const number = steps.indexOf(step) + 1;
                const open = step.status === 'open';
                return (
                    <Animated.View
                        key={step.id}
                        layout={reduceMotion ? undefined : LAYOUT}
                        entering={reduceMotion ? undefined : FadeIn.duration(MOTION.status.open)}
                        testID={testID ? `${testID}-${step.id}` : undefined}
                        style={[styles.step, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }]}
                    >
                        <View style={styles.head}>
                            {open ? (
                                <View style={[styles.badge, { backgroundColor: colors.accent }]}>
                                    <Text style={[styles.badgeText, { color: colors.onAccent }]}>{number}</Text>
                                </View>
                            ) : (
                                <View style={[styles.badge, { backgroundColor: colors.surfaceRaised }]}>
                                    <MaterialIcons name="check" size={14} color={colors.positive} />
                                </View>
                            )}
                            <View style={styles.titles}>
                                <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                                    {step.title}
                                </Text>
                                {open && step.hint ? (
                                    <Text style={[styles.sub, { color: colors.ink2 }]}>{step.hint}</Text>
                                ) : null}
                                {!open && step.summary ? (
                                    <Text style={[styles.sub, { color: colors.ink3 }]}>{step.summary}</Text>
                                ) : null}
                            </View>
                            {!open && step.actionLabel && step.onAction ? (
                                <Pressable
                                    onPress={step.onAction}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${step.actionLabel}, ${step.title}`}
                                    hitSlop={8}
                                    style={styles.action}
                                    testID={testID ? `${testID}-${step.id}-action` : undefined}
                                >
                                    <Text style={[styles.actionText, { color: colors.accentText }]}>{step.actionLabel}</Text>
                                </Pressable>
                            ) : null}
                        </View>
                        {open && step.children ? <View style={styles.body}>{step.children}</View> : null}
                    </Animated.View>
                );
            })}
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
    step: { paddingHorizontal: 16, paddingVertical: 14 },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    badge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    badgeText: { fontSize: 13, fontWeight: '700' },
    titles: { flex: 1, gap: 2 },
    title: { fontSize: 15, fontWeight: '600' },
    sub: { fontSize: 13, lineHeight: 18 },
    action: { minHeight: 28, justifyContent: 'center' },
    actionText: { fontSize: 14, fontWeight: '600' },
    body: { marginTop: 12, marginStart: 36 },
});
