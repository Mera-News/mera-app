import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { PRIVACY_URL } from '@/lib/config/branding';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import React from 'react';
import { useTranslation } from 'react-i18next';

// The policy's section on your own services. A page without the anchor yet opens at its top.
const OWN_SERVICES_PRIVACY = `${PRIVACY_URL}#own-services`;

/** "Read the privacy policy", styled like the link on Manage data. */
export function PrivacyLink({ testID }: { testID: string }) {
    const { t } = useTranslation();
    return (
        <Pressable
            testID={testID}
            onPress={() => openInAppBrowser(withAppLanguage(OWN_SERVICES_PRIVACY))}
            accessible
            accessibilityRole="link"
            accessibilityLabel={t('manageData.keeps.privacyLink')}
            className="justify-center self-start"
            style={{ minHeight: 44, marginHorizontal: 4 }}
        >
            <Text size="sm" className="text-primary-500 font-semibold">
                {t('manageData.keeps.privacyLink')}
            </Text>
        </Pressable>
    );
}
