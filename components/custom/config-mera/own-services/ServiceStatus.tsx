import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';

type Props = {
    /** Null while there is nothing to say; the live region stays mounted so a later line is announced. */
    readonly line: { readonly ok: boolean; readonly text: string } | null;
    readonly testID: string;
};

/** An icon and a line. The icon is never read aloud; a change is announced (iOS has no live regions). */
export function ServiceStatus({ line, testID }: Props) {
    const colors = useColors();
    const text = line?.text ?? null;
    const last = useRef(text);
    useEffect(() => {
        if (text && text !== last.current && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
        last.current = text;
    }, [text]);
    return (
        <View testID={testID} accessibilityLiveRegion="polite" style={{ marginTop: line ? 12 : 0 }}>
            {line ? (
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginHorizontal: 4 }}>
                    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ marginTop: 1 }}>
                        <MaterialIcons
                            name={line.ok ? 'check-circle' : 'cancel'}
                            size={18}
                            color={line.ok ? colors.positive : colors.negative}
                        />
                    </View>
                    <Text style={{ flex: 1, color: line.ok ? colors.ink : colors.negative, fontSize: 15, lineHeight: 21 }}>{line.text}</Text>
                </View>
            ) : null}
        </View>
    );
}
