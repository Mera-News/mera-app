import { Group, Row } from '@/components/custom/you/rows';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { useColors } from '@/lib/theme/tokens';
import { router, type Href } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { BetaIntro } from './BetaIntro';
import { ModeSwitchRow, ServicePage } from './ModeSwitchRow';
import { OWN_ROUTES } from './own-services-copy';
import { ServiceField } from './ServiceField';
import { ServiceStatus } from './ServiceStatus';
import { useOwnNewsServer } from './useOwnNewsServer';

/** The form, mounted once the stored config is read in, so its fields start from it. */
function OwnNewsForm() {
    const { t } = useTranslation();
    const colors = useColors();
    const s = useOwnNewsServer();
    return (
        <>
            <BetaIntro text={t('ownServices.news.intro')} testID="own-news-beta" />
            <ServiceField kind="address" label={t('ownServices.field.address')} value={s.address} onChangeText={s.setAddress} error={s.addressError} testID="own-news-address" />
            <ServiceField kind="key" label={t('ownServices.field.key')} value={s.key} onChangeText={s.setKey} testID="own-news-key" />
            <Button
                testID="own-news-check"
                action="primary"
                variant="solid"
                size="md"
                style={{ minHeight: 48, marginTop: 16 }}
                isDisabled={!s.canCheck}
                onPress={() => void s.check()}
            >
                {s.checking ? <ButtonSpinner /> : null}
                <ButtonText>{s.checkLabel}</ButtonText>
            </Button>
            <ServiceStatus testID="own-news-status" line={s.statusLine} />
            {s.offLine ? <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, marginTop: 8, marginHorizontal: 4 }}>{s.offLine}</Text> : null}
            <ModeSwitchRow
                testID="own-news-switch"
                title={t('ownServices.news.switch')}
                value={s.switchValue}
                onToggle={(next) => void s.toggle(next)}
                disabled={s.switchDisabled}
                reason={s.reason}
                error={s.error}
            />
            <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, marginTop: 8, marginHorizontal: 4 }}>{t('ownServices.news.topicsLine')}</Text>
            {s.showMissing ? (
                <View style={{ marginTop: 14 }}>
                    <Group>
                        <Row testID="own-news-missing-row" title={t('ownServices.news.missingRow')} onPress={() => router.push(OWN_ROUTES.newsMissing as Href)} />
                    </Group>
                </View>
            ) : null}
        </>
    );
}

/** Settings > Mera Protocol > Your own news server. */
export default function OwnNewsServerScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const hydrated = ownNewsState.useStore((s) => s.hydrated);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        ownNewsState.hydrate().catch(() => setFailed(true));
    }, []);
    // A failed read is not "no server": the form stays away so it cannot save over what is stored.
    return (
        <ServicePage title={t('ownServices.news.title')} onBack={onBack} loading={!hydrated || failed}>
            <OwnNewsForm />
        </ServicePage>
    );
}
