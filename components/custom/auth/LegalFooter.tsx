import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import {
    CONTENT_POLICY_URL,
    FAQ_URL,
    GITHUB_URL,
    PRIVACY_URL,
    TERMS_URL,
    WEBSITE_URL,
} from '@/lib/config/branding';
import { getAppVersionLabel } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';

/**
 * The pre-auth footer: one quiet entry line that opens a sheet with every
 * legal and project link, over a single muted meta line. Replaces the old
 * four-pill + two-icon + version + copyright stack, which stacked four
 * visual layers on a screen whose job is one primary action.
 *
 * The sheet reuses LanguageSelector's proven recipe (RN Modal `pageSheet`
 * inside its own dark GluestackUIProvider) — there is no Actionsheet
 * primitive under components/ui.
 */
const LegalFooter: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [showSheet, setShowSheet] = useState(false);

    // Policy pages localise (withAppLanguage); the project links do not —
    // same split the old pill/icon footer used.
    const links: { key: string; label: string; open: () => Promise<unknown> }[] = [
        { key: 'privacy', label: t('auth.privacyPolicy'), open: () => openInAppBrowser(withAppLanguage(PRIVACY_URL)) },
        { key: 'terms', label: t('auth.termsOfService'), open: () => openInAppBrowser(withAppLanguage(TERMS_URL)) },
        { key: 'content', label: t('auth.contentPolicy'), open: () => openInAppBrowser(withAppLanguage(CONTENT_POLICY_URL)) },
        { key: 'faq', label: t('auth.faq'), open: () => openInAppBrowser(withAppLanguage(FAQ_URL)) },
        { key: 'source', label: t('auth.sourceCode'), open: () => openInAppBrowser(GITHUB_URL) },
        { key: 'website', label: t('auth.website'), open: () => openInAppBrowser(WEBSITE_URL) },
    ];

    return (
        <Box accessible={false} className="items-center" style={{ paddingBottom: insets.bottom + 16 }}>
            <Pressable
                testID="auth-about-legal"
                onPress={() => setShowSheet(true)}
                accessible
                accessibilityRole="button"
                accessibilityLabel={t('auth.aboutLegal')}
                className="py-2"
            >
                <Text size="sm" className="text-gray-400">
                    {t('auth.aboutLegal')}
                </Text>
            </Pressable>
            <Text size="xs" className="text-gray-500">
                {`© ${new Date().getFullYear()} Mera Labs B.V. · ${getAppVersionLabel()}`}
            </Text>

            <Modal
                visible={showSheet}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setShowSheet(false)}
            >
                <GluestackUIProvider mode="dark">
                    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top + 16 }}>
                        <HStack className="items-center justify-between px-5 pb-4">
                            <Text className="text-white text-xl font-semibold">
                                {t('auth.aboutLegal')}
                            </Text>
                            <Pressable
                                testID="auth-about-legal-close"
                                onPress={() => setShowSheet(false)}
                                accessible
                                accessibilityRole="button"
                                accessibilityLabel={t('common.done')}
                            >
                                <MaterialIcons name="close" size={24} color="#ffffff" />
                            </Pressable>
                        </HStack>
                        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
                            {links.map((link) => (
                                <TouchableOpacity
                                    key={link.key}
                                    testID={`auth-legal-link-${link.key}`}
                                    accessible
                                    accessibilityRole="link"
                                    accessibilityLabel={link.label}
                                    onPress={() => {
                                        void link.open();
                                    }}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        paddingVertical: 16,
                                        paddingHorizontal: 20,
                                        borderBottomWidth: 1,
                                        borderBottomColor: '#1f2937',
                                    }}
                                >
                                    <Text className="text-white">{link.label}</Text>
                                    <MaterialIcons name="open-in-new" size={18} color="#9ca3af" />
                                </TouchableOpacity>
                            ))}
                            <Box className="items-center mt-6">
                                <Text size="xs" className="text-gray-500">
                                    {`© ${new Date().getFullYear()} Mera Labs B.V. · ${getAppVersionLabel()}`}
                                </Text>
                            </Box>
                        </ScrollView>
                    </Box>
                </GluestackUIProvider>
            </Modal>
        </Box>
    );
};

export default LegalFooter;
