// S5's section of the navx2 P2 kit gallery (app/dev-kit.tsx): every kit piece
// this area owns, in every state. Dev only; deleted in P13.
import NotificationTimes from '@/components/custom/config-mera/NotificationTimes';
import { useColors } from '@/lib/theme/tokens';
import React, { useState } from 'react';
import { Text, View } from 'react-native';

/** One live NotificationTimes, starting from `initial`: tap to pick, × to remove. */
function TimesState({ title, initial }: { title: string; initial: number[] }) {
    const colors = useColors();
    const [hours, setHours] = useState(initial);
    return (
        <View style={{ marginBottom: 20 }} testID={`kit-times-${initial.length}`}>
            <Text style={{ color: colors.ink2, fontSize: 13, marginBottom: 8 }}>{title}</Text>
            <NotificationTimes hours={hours} onChange={setHours} />
        </View>
    );
}

export default function KitGallery() {
    return (
        <View>
            <TimesState title="Notification times: none picked (wheel open, tap saves)" initial={[]} />
            <TimesState title="Notification times: two picked (Add a time)" initial={[8, 18]} />
            <TimesState title="Notification times: three picked (Add hidden)" initial={[7, 12, 20]} />
            {/* Room below the last tile, so its pills never sit at the screen's edge in a capture. */}
            <View style={{ height: 120 }} />
        </View>
    );
}
