import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { useDevTestAccountLink, type DevTestAccountLinkParams } from '@/components/custom/auth/useDevTestAccountLink';
import { useColors } from '@/lib/theme/tokens';

/** Dev builds only: signs in to a TEST account by handle, then the launch gate.
 *  A release build goes straight to '/'. */
export default function DevTestAccountRoute() {
    const params = useLocalSearchParams<{ handle?: string; new?: string; reset?: string }>();
    useDevTestAccountLink(params as DevTestAccountLinkParams);
    const colors = useColors();
    return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.base }}>
            <ActivityIndicator color={colors.ink} />
        </View>
    );
}
