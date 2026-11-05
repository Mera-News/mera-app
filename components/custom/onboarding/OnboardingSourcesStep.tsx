import React, { useEffect, useState } from 'react';
import { Pressable as RNPressable, ScrollView, StyleSheet, Text as RNText, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';

import { useAdjustedSources } from '@/components/custom/publication-preferences/use-adjusted-sources';
import SourceSearch from '@/components/custom/publication-preferences/SourceSearch';
import { useSubscribeFlow } from '@/components/custom/publication-preferences/use-subscribe-flow';
import type { PublisherSearchHit } from '@/lib/generated/graphql-types';
import { useIsOnline } from '@/lib/stores/network-store';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';

import { keyboardLift } from './keyboard-lift';

const TOGGLE = 44;

/**
 * Step 1: search only. Picks are the shared source rows' own writes, so the
 * wizard needs just to know whether any exist (Skip becomes Next).
 */
const OnboardingSourcesStep: React.FC<{ readonly onHasPicksChange: (has: boolean) => void }> = ({ onHasPicksChange }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const online = useIsOnline();
    const flow = useSubscribeFlow();
    const { publications, scopes } = useAdjustedSources();
    const [focused, setFocused] = useState(false);
    const keyboard = useReanimatedKeyboardAnimation();
    const lift = useAnimatedStyle(() => ({ paddingBottom: keyboardLift(keyboard.height.value, insets.bottom) }));

    const hasPicks = publications.length + scopes.length > 0;
    useEffect(() => {
        onHasPicksChange(hasPicks);
    }, [hasPicks, onHasPicksChange]);

    const footerFor = (hit: PublisherSearchHit) => {
        const row = flow.subscriptions.items.find((r) => r.publisherId === hit._id);
        const checked = !!row;
        const busyId = flow.subscriptions.busyId;
        const busy = !!busyId && (busyId === hit._id || busyId === row?.id);
        const onPress = () => {
            if (row) {
                void flow.subscriptions.removeSubscription(row).then((ok) => {
                    if (ok) toastManager.showInfo(t('subscriptions.removed', { publisher: row.publisherName }));
                });
                return;
            }
            void flow.confirmDirectly({
                publisherId: hit._id,
                publisherName: hit.name,
                countryCode: hit.country_code,
                subscriptionUri: hit.subscription_uri ?? null,
            });
        };
        return (
            <View style={styles.toggle} testID={`sources-subscribe-${hit._id}-frame`}>
                <View style={styles.toggleVisual} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <MaterialIcons name={checked ? 'check-box' : 'check-box-outline-blank'} size={22} color={checked ? colors.ink : colors.ink3} />
                    <RNText style={[styles.toggleLabel, { color: colors.ink2 }]}>{t('onboarding.iSubscribe')}</RNText>
                </View>
                <RNPressable
                    testID={`sources-subscribe-${hit._id}`}
                    onPress={onPress}
                    disabled={busy}
                    accessibilityRole="switch"
                    accessibilityState={{ checked, disabled: busy }}
                    accessibilityLabel={t('onboarding.iSubscribeA11y', { publisher: hit.name })}
                    style={StyleSheet.absoluteFill}
                />
            </View>
        );
    };

    return (
        <Animated.View style={[styles.flex, lift]} testID="onboarding-sources-step">
            <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                {!focused ? (
                    <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.remind}>
                        <RNText accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                            {t('onboarding.sourcesTitle')}
                        </RNText>
                        <RNText style={[styles.body, { color: colors.ink2 }]}>{t('onboarding.sourcesBody')}</RNText>
                    </Animated.View>
                ) : null}
                <Animated.View layout={LinearTransition}>
                    <SourceSearch onboarding footerFor={footerFor} onFocusChange={setFocused} />
                    {!online ? (
                        <RNText style={[styles.hint, { color: colors.ink2 }]}>{t('onboarding.sourcesOffline')}</RNText>
                    ) : null}
                </Animated.View>
            </ScrollView>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    flex: { flex: 1 },
    content: { paddingBottom: 24 },
    remind: { paddingHorizontal: 20, paddingTop: 16, gap: 10, marginBottom: 12 },
    title: { fontSize: 26, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 22 },
    hint: { fontSize: 14, paddingHorizontal: 20 },
    toggle: { height: TOGGLE, justifyContent: 'center', paddingHorizontal: 16 },
    toggleVisual: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    toggleLabel: { fontSize: 14 },
});

export default OnboardingSourcesStep;
