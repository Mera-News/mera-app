import { Group, Help, Row } from '@/components/custom/you/rows';
import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { useColors } from '@/lib/theme/tokens';
import { router, type Href } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ModeSwitchRow, ServicePage } from './ModeSwitchRow';
import { OWN_ROUTES } from './own-services-copy';
import { ServiceField } from './ServiceField';
import { ServiceStatus } from './ServiceStatus';
import { useOwnAiService } from './useOwnAiService';

/** The form, mounted once the stored config is read in, so its fields start from it. */
function OwnAiForm() {
    const { t } = useTranslation();
    const colors = useColors();
    const s = useOwnAiService();
    return (
        <>
            <Help>{t('ownServices.ai.intro')}</Help>
            <ServiceField kind="address" label={t('ownServices.field.address')} value={s.address} onChangeText={s.setAddress} error={s.addressError} testID="own-ai-address" />
            <ServiceField kind="text" label={t('ownServices.ai.model')} value={s.model} onChangeText={s.setModel} testID="own-ai-model" />
            <ServiceField kind="key" label={t('ownServices.field.key')} value={s.key} onChangeText={s.setKey} testID="own-ai-key" />
            <Button
                testID="own-ai-check"
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
            <ServiceStatus testID="own-ai-status" line={s.statusLine} />
            {s.offLine ? <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, marginTop: 8, marginHorizontal: 4 }}>{s.offLine}</Text> : null}
            <Text testID="own-ai-warning" style={{ color: colors.ink, fontSize: 15, lineHeight: 21, marginTop: 20, marginHorizontal: 4 }}>
                {t('ownServices.ai.warning')}
            </Text>
            <ModeSwitchRow
                testID="own-ai-switch"
                title={t('ownServices.ai.switch')}
                value={s.switchValue}
                onToggle={(next) => void s.toggle(next)}
                disabled={s.switchDisabled}
                reason={s.reason}
                error={s.error}
            />
            <View style={{ marginTop: 14 }}>
                <Group>
                    <Row testID="own-ai-changes-row" title={t('ownServices.ai.whatChanges')} onPress={() => router.push(OWN_ROUTES.aiChanges as Href)} />
                </Group>
            </View>
        </>
    );
}

/** Settings > Mera Protocol > Your own AI service. */
export default function OwnAiServiceScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const hydrated = ownAiState.useStore((s) => s.hydrated);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        ownAiState.hydrate().catch(() => setFailed(true));
    }, []);
    // A failed read is not "no service": the form stays away so it cannot save over what is stored.
    return (
        <ServicePage title={t('ownServices.ai.title')} onBack={onBack} loading={!hydrated || failed}>
            <OwnAiForm />
        </ServicePage>
    );
}
