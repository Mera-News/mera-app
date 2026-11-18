import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { Group, Row } from '@/components/custom/you/rows';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The chrome of the four own-service pages: backdrop, header, a scrolling column. `loading` shows a spinner instead. */
export function ServicePage({
    title,
    onBack,
    loading = false,
    children,
}: {
    readonly title: string;
    readonly onBack?: () => void;
    readonly loading?: boolean;
    readonly children?: React.ReactNode;
}) {
    const insets = useSafeAreaInsets();
    const endClearance = useListEndClearance();
    return (
        <View style={{ flex: 1 }}>
            <AbstractGradientBackdrop />
            <View style={{ flex: 1, paddingTop: insets.top }}>
                <DrillDownHeader title={title} onBack={onBack} />
                {loading ? (
                    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                        <Spinner size="large" />
                    </View>
                ) : (
                    <ScrollView
                        keyboardShouldPersistTaps="handled"
                        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: endClearance }}
                    >
                        {children}
                    </ScrollView>
                )}
            </View>
        </View>
    );
}

type Props = {
    readonly title: string;
    readonly value: boolean;
    readonly onToggle: (next: boolean) => void;
    /** Dimmed. The reason is its accessibility hint, and shows as a line with its button under the row. */
    readonly disabled: boolean;
    readonly reason?: { readonly line: string; readonly button?: { readonly label: string; readonly onPress: () => void } } | null;
    /** A line from a turn-on that was refused. */
    readonly error?: string | null;
    readonly testID: string;
};

/** The "Use this ..." row: a switch, and under it why it cannot be turned on, with a way forward. */
export function ModeSwitchRow({ title, value, onToggle, disabled, reason, error, testID }: Props) {
    const colors = useColors();
    return (
        <View style={{ marginTop: 14 }}>
            <Group>
                <Row
                    title={title}
                    trailing={
                        <Switch
                            testID={testID}
                            value={value}
                            onToggle={onToggle}
                            isDisabled={disabled}
                            size="md"
                            accessibilityLabel={title}
                            accessibilityHint={disabled ? reason?.line : undefined}
                            accessibilityState={disabled ? { disabled: true } : undefined}
                        />
                    }
                />
            </Group>
            {reason ? (
                <View style={{ marginTop: 8, marginHorizontal: 4 }}>
                    <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{reason.line}</Text>
                    {reason.button ? (
                        <Button action="secondary" variant="outline" size="md" style={{ minHeight: 44, marginTop: 8, alignSelf: 'flex-start' }} onPress={reason.button.onPress}>
                            <ButtonText>{reason.button.label}</ButtonText>
                        </Button>
                    ) : null}
                </View>
            ) : null}
            {error ? <Text style={{ color: colors.negative, fontSize: 14, lineHeight: 20, marginTop: 8, marginHorizontal: 4 }}>{error}</Text> : null}
        </View>
    );
}
