import { Group, Row } from '@/components/custom/you/rows';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { BetaIntro } from './BetaIntro';
import { ServicePage } from './ModeSwitchRow';
import { PrivacyLink } from './PrivacyLink';
import { ServiceStatus } from './ServiceStatus';
import { OWN_ROUTES } from './own-services-copy';
import { useOwnPod } from './useOwnPod';

const grey = (colors: ReturnType<typeof useColors>) => ({ color: colors.ink2, fontSize: 14, lineHeight: 20, marginTop: 8, marginHorizontal: 4 }) as const;

function Unpaired({ s }: { s: ReturnType<typeof useOwnPod> }) {
    const { t } = useTranslation();
    const colors = useColors();
    const dimmed = s.blocked != null;
    return (
        <>
            <BetaIntro text={t('ownServices.pod.intro')} testID="own-pod-beta" />
            <Button
                testID="own-pod-pair-button"
                action="primary"
                variant="solid"
                size="md"
                style={{ minHeight: 48, marginTop: 16 }}
                isDisabled={dimmed || s.pairBusy}
                accessibilityRole="button"
                accessibilityLabel={t('ownServices.pod.pairButton')}
                onPress={() => router.push(OWN_ROUTES.podPair as Href)}
            >
                {s.pairBusy ? <ButtonSpinner /> : null}
                <ButtonText>{t('ownServices.pod.pairButton')}</ButtonText>
            </Button>
            {s.blocked ? (
                <View style={{ marginTop: 8, marginHorizontal: 4 }}>
                    <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{s.blocked.line}</Text>
                    <Button action="secondary" variant="outline" size="md" style={{ minHeight: 44, marginTop: 8, alignSelf: 'flex-start' }} onPress={s.blocked.button.onPress}>
                        <ButtonText>{s.blocked.button.label}</ButtonText>
                    </Button>
                </View>
            ) : null}
            {s.pairError ? (
                <Text testID="own-pod-error" accessibilityLiveRegion="polite" style={{ ...grey(colors), color: colors.negative }}>
                    {s.pairError}
                </Text>
            ) : null}
            <Text testID="own-pod-note" style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 12, marginHorizontal: 4 }}>{t('ownServices.pod.pageNote')}</Text>
            <PrivacyLink testID="own-pod-privacy" />
            <View style={{ marginTop: 14 }}>
                <Group>
                    <Row testID="own-pod-enter-code" title={t('ownServices.pod.enterCodeRow')} onPress={() => router.push(OWN_ROUTES.podCode as Href)} />
                </Group>
            </View>
        </>
    );
}

function Paired({ s }: { s: ReturnType<typeof useOwnPod> }) {
    const { t } = useTranslation();
    const colors = useColors();
    return (
        <>
            <Group>
                <Row testID="own-pod-server" title={t('ownServices.pod.server')} value={s.host ?? ''} />
                {s.lastSynced ? <Row testID="own-pod-last-synced" title={t('ownServices.pod.lastSynced')} value={s.lastSynced} /> : null}
                <Row
                    title={t('ownServices.pod.readTheNews')}
                    trailing={
                        <Switch
                            testID="own-pod-reading-switch"
                            value={s.readingOn}
                            onToggle={(next: boolean) => void s.toggleReading(next)}
                            isDisabled={s.readingDimmed}
                            size="md"
                            accessibilityLabel={t('ownServices.pod.readTheNews')}
                            accessibilityState={s.readingDimmed ? { disabled: true } : undefined}
                        />
                    }
                />
            </Group>
            <Button
                testID="own-pod-sync"
                action="primary"
                variant="solid"
                size="md"
                style={{ minHeight: 48, marginTop: 16 }}
                isDisabled={s.syncing}
                accessibilityRole="button"
                accessibilityLabel={t('ownServices.pod.syncNow')}
                onPress={() => void s.syncNow()}
            >
                {s.syncing ? <ButtonSpinner /> : null}
                <ButtonText>{t('ownServices.pod.syncNow')}</ButtonText>
            </Button>
            <ServiceStatus testID="own-pod-status" line={s.healthLine ? { ok: false, text: s.healthLine } : null} />
            {s.refused ? (
                <Button
                    testID="own-pod-pair-again"
                    action="secondary"
                    variant="outline"
                    size="md"
                    style={{ minHeight: 44, marginTop: 8, alignSelf: 'flex-start' }}
                    accessibilityRole="button"
                    accessibilityLabel={t('ownServices.pod.pairAgain')}
                    onPress={() => void s.pairAgain()}
                >
                    <ButtonText>{t('ownServices.pod.pairAgain')}</ButtonText>
                </Button>
            ) : null}
            <View style={{ marginTop: 14 }}>
                <Group>
                    <Row testID="own-pod-unpair" title={t('ownServices.pod.unpair')} titleColor={colors.negative} onPress={() => void s.unpair()} hideChevron />
                </Group>
            </View>
        </>
    );
}

/** Settings > Mera Protocol > Your own Mera News server. */
export default function OwnPodScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const s = useOwnPod();
    return (
        <ServicePage title={t('ownServices.pod.title')} onBack={onBack} loading={!s.hydrated}>
            {s.paired ? <Paired s={s} /> : <Unpaired s={s} />}
        </ServicePage>
    );
}
