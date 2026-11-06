import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { TOUCH_FRAME } from '@/components/custom/floating-chat/glyph-safe';
import AddLocationView from '@/components/custom/locations/AddLocationView';
import { homeFactStatement } from '@/components/custom/locations/location-display';
import type { ChosenPlace } from '@/components/custom/locations/useAddLocation';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { upsertLocation } from '@/lib/database/services/location-service';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { useColors } from '@/lib/theme/tokens';

import { keyboardLift } from './keyboard-lift';

interface OnboardingCityStepProps {
    /** Back to the chat, with nothing saved. */
    onClose: () => void;
    /** On to the sources step: the city and its fact are saved, or the reader declined. */
    onDone: () => void;
}

/**
 * The least Mera can personalise with, and the reader may decline it. No model is
 * needed, so on-device readers are covered too. The location alone leaves zero
 * facts, so the fact is written here, under the canonical home key the topic
 * generator resolves, and the location is linked to it.
 */
export default function OnboardingCityStep({ onClose, onDone }: OnboardingCityStepProps) {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const keyboard = useReanimatedKeyboardAnimation();
    const lift = useAnimatedStyle(() => ({ paddingBottom: keyboardLift(keyboard.height.value, insets.bottom) }));

    const save = async (place: ChosenPlace) => {
        const { savedFacts } = await commitFactChoices([
            { statement: homeFactStatement(place), questionnaire: { attribute: CANONICAL_LOCATION_KEY } },
        ]);
        // The link is how Clear profile finds this row. Provenance stays 'user',
        // so the geo sweep leaves it alone.
        await upsertLocation({
            city: place.city,
            countryCode: place.countryCode,
            role: 'home',
            sourceFactId: savedFacts[0].id,
        });
        onDone();
    };

    return (
        <Animated.View style={[styles.root, lift]} testID="onboarding-city-step">
            <AddLocationView
                homeOnly
                onClose={onClose}
                onSaved={save}
                renderIdle={() => (
                    <View style={styles.decline}>
                        <Pressable
                            style={styles.declineFrame}
                            onPress={onDone}
                            accessibilityRole="button"
                            testID="onboarding-city-decline"
                        >
                            <Text style={[styles.declineText, { color: colors.accentText }]}>{t('onboarding.ratherNotSay')}</Text>
                        </Pressable>
                    </View>
                )}
                header={
                    <View style={styles.ask}>
                        <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>
                            {t('onboarding.noFactsTitle')}
                        </Text>
                        <Text style={[styles.body, { color: colors.ink2 }]}>{t('onboarding.noFactsBody')}</Text>
                    </View>
                }
            />
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1 },
    ask: { paddingHorizontal: 20, paddingTop: 16, gap: 10 },
    title: { fontSize: 26, fontWeight: '700' },
    body: { fontSize: 15, lineHeight: 22 },
    decline: { paddingHorizontal: 20, alignItems: 'flex-start' },
    declineFrame: { minHeight: TOUCH_FRAME, justifyContent: 'center' },
    declineText: { fontSize: 15, fontWeight: '600' },
});
