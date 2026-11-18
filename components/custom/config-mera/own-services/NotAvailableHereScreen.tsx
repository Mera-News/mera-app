import { Group, Help, Row } from '@/components/custom/you/rows';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ServicePage } from './ModeSwitchRow';
import { FEATURE_KEY } from './own-services-copy';
import { useMissingFeatures } from './useOwnNewsServer';

/** One tap down from the own news page: what the person's server does not offer. Plain rows, nothing to press. */
export default function NotAvailableHereScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const missing = useMissingFeatures();
    useEffect(() => {
        ownNewsState.hydrate().catch(() => {});
    }, []);
    return (
        <ServicePage title={t('ownServices.news.missing.title')} onBack={onBack}>
            {missing === null ? (
                <Help>{t('ownServices.news.missing.unknown')}</Help>
            ) : (
                <>
                    <Help>{t('ownServices.news.missing.intro')}</Help>
                    <Group>
                        {missing.map((f) => (
                            <Row key={f} title={t(FEATURE_KEY[f])} />
                        ))}
                    </Group>
                </>
            )}
        </ServicePage>
    );
}
