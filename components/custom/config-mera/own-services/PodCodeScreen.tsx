import { Button, ButtonSpinner, ButtonText } from '@/components/ui/button';
import { parseServiceAddress } from '@/lib/own-services/address';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ServicePage } from './ModeSwitchRow';
import { ServiceField } from './ServiceField';
import { ADDRESS_ERROR_KEY } from './own-services-copy';
import { usePairFlow } from './useOwnPod';

/** Pair with an address and a code typed in. */
export default function PodCodeScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const [address, setAddress] = useState('');
    const [code, setCode] = useState('');
    const pair = usePairFlow('address');
    const trimmed = address.trim();
    const parsed = trimmed ? parseServiceAddress(trimmed) : null;
    const addressError = parsed && !parsed.ok ? t(ADDRESS_ERROR_KEY[parsed.reason]) : pair.line?.field === 'address' ? pair.line.text : null;
    const codeError = pair.line?.field === 'code' ? pair.line.text : null;
    const ready = parsed?.ok === true && code.trim() !== '' && !pair.busy;
    return (
        <ServicePage title={t('ownServices.pod.codeTitle')} onBack={onBack}>
            <ServiceField kind="address" label={t('ownServices.pod.serverAddress')} value={address} onChangeText={setAddress} error={addressError} testID="own-pod-address" />
            <ServiceField kind="code" label={t('ownServices.pod.code')} value={code} onChangeText={setCode} error={codeError} testID="own-pod-code" />
            <Button
                testID="own-pod-code-pair"
                action="primary"
                variant="solid"
                size="md"
                style={{ minHeight: 48, marginTop: 16 }}
                isDisabled={!ready}
                accessibilityRole="button"
                accessibilityLabel={t('ownServices.pod.pair')}
                onPress={() => parsed?.ok && void pair.run({ baseUrl: parsed.url, code })}
            >
                {pair.busy ? <ButtonSpinner /> : null}
                <ButtonText>{t('ownServices.pod.pair')}</ButtonText>
            </Button>
        </ServicePage>
    );
}
