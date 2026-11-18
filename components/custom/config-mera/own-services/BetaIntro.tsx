import BetaBadge from '@/components/custom/BetaBadge';
import { Help } from '@/components/custom/you/rows';
import React from 'react';
import { View } from 'react-native';

/** An own-service page's intro with the Beta pill beside it, laid out like the On this phone tab's. */
export function BetaIntro({ text, testID }: { text: string; testID: string }) {
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flexShrink: 1 }}>
                <Help>{text}</Help>
            </View>
            <BetaBadge testID={testID} />
        </View>
    );
}
