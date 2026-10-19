import { Group, GroupLabel, Row, Badge } from '@/components/custom/you/rows';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { CONTENT_POLICY_URL, GITHUB_URL, PRIVACY_URL, TERMS_URL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useColors } from '@/lib/theme/tokens';
import { getNativeLanguageName } from '@/lib/translation-service';
import { maskEmail } from '@/lib/algorithms/mask-email';
import { getAppVersion, getGitCommit } from '@/lib/version';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { router, useFocusEffect, useRouter, type Href } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { TEXT_SIZE_LABEL_KEYS } from './DisplaySettingsScreen';
import SettingsUsageCard from './SettingsUsageCard';
import { useAppPreferences } from './useAppPreferences';
import { useRestorePurchases } from './useRestorePurchases';
import { emailCutoffLabel, isEmailAccount, requestMoveToPhone } from '@/components/custom/auth/move-to-phone';
import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';

/** Settings sub-screens pushed inside the You stack, so the tab bar stays. */
type YouSettingsScreen = 'display' | 'notifications' | 'mera-protocol' | 'app-lock' | 'data';
const youScreen = (screen: YouSettingsScreen) => `/logged-in/app_container/you/${screen}` as Href;


/**
 * You > Settings (FinalSettings #1-#3): the plan card, then General, Privacy
 * and security, Help, Account, Developer (only in developer mode), and a
 * footer of four text links and the version line. Every value is read from
 * the setting it names; a few re-read on focus (the tab stays mounted).
 */
const AppPreferencesTab: React.FC = () => {
    const routerHook = useRouter();
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const {
        supportBusy,
        openSupport,
        appLanguage,
        processingMode,
        lockEnabled,
        displayEmail,
        confirmDeleteAccount,
        confirmLogout,
        devMode,
        setDeveloperMode,
        onVersionTap,
        refreshOnFocus,
        backupOn,
        textStep,
        faqOpening,
        openFaq,
    } = useAppPreferences();
    useFocusEffect(refreshOnFocus);
    const { restoring, restore } = useRestorePurchases();
    // The move row is for accounts that still have an email (a displayed one, or the stored row / session).
    const [emailAccount, setEmailAccount] = useState(false);
    useEffect(() => {
        let live = true;
        void isEmailAccount().then((yes) => { if (live) setEmailAccount(yes); });
        return () => { live = false; };
    }, [displayEmail]);
    const showMoveRow = emailAccount || !!displayEmail;

    const busy = <Spinner size="small" />;
    const version = getAppVersion();
    const versionText = t('you.settings.version', {
        version: devMode ? `${version} (${getGitCommit()})` : version,
    });

    const link = (label: string, url: string, testID: string) => (
        <Pressable
            key={testID}
            testID={testID}
            onPress={() => void openInAppBrowser(url)}
            accessibilityRole="link"
            accessibilityLabel={label}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}
        >
            <Text style={{ color: colors.ink2, fontSize: 13 }}>{label}</Text>
        </Pressable>
    );

    return (
        // No flex-1 and no fill: mounted inside SettingsPage's ScrollView
        // (you/YouPages.tsx), whose bottom padding clears the tab bar.
        <View style={{ paddingHorizontal: PAGE_SIDE_INSET }}>
            {/* First content at the page baseline (header + PAGE_CONTENT_GAP),
                like every tab page: no extra top margin. */}
            <SettingsUsageCard />

            <GroupLabel testID="settings-group-general">{t('you.settings.groupGeneral')}</GroupLabel>
            <Group>
                <Row
                    testID="settings-row-language"
                    leadingIcon="translate"
                    title={t('settings.languageRow')}
                    value={getNativeLanguageName(appLanguage) ?? undefined}
                    onPress={() => routerHook.push('/logged-in/preferences/language' as Href)}
                />
                <Row
                    testID="settings-row-display"
                    leadingIcon="text-fields"
                    title={t('display.screenTitle')}
                    value={t(TEXT_SIZE_LABEL_KEYS[textStep])}
                    onPress={() => routerHook.push(youScreen('display'))}
                />
                <Row
                    testID="settings-row-notifications"
                    leadingIcon="notifications-none"
                    title={t('preferences.notifications')}
                    onPress={() => routerHook.push(youScreen('notifications'))}
                />
            </Group>

            <GroupLabel testID="settings-group-privacy">{t('you.settings.groupPrivacy')}</GroupLabel>
            <Group>
                <Row
                    testID="settings-row-mera-protocol"
                    leadingIcon="verified-user"
                    title={t('preferences.meraProtocol')}
                    trailing={
                        <Badge
                            tone="positive"
                            label={processingMode === ProcessingMode.OnDevice ? t('you.settings.onThisPhone') : t('you.settings.privateCloud')}
                        />
                    }
                    onPress={() => routerHook.push(youScreen('mera-protocol'))}
                />
                <Row
                    testID="settings-row-app-lock"
                    leadingIcon="lock-outline"
                    title={t('you.settings.appLock')}
                    value={lockEnabled ? t('you.settings.on') : t('you.settings.off')}
                    onPress={() => routerHook.push(youScreen('app-lock'))}
                />
                <Row
                    testID="settings-row-backup"
                    leadingIcon="folder-open"
                    title={t('you.settings.yourData')}
                    value={backupOn ? t('you.settings.backupOn') : t('you.settings.backupOff')}
                    onPress={() => routerHook.push(youScreen('data'))}
                />
            </Group>

            <GroupLabel testID="settings-group-help">{t('settings.groupHelp')}</GroupLabel>
            <Group>
                <Row
                    testID="settings-row-tutorials"
                    leadingIcon="school"
                    title={t('tutorials.entryRow')}
                    onPress={() => routerHook.push('/tutorials' as Href)}
                />
                <Row
                    testID="settings-row-faq"
                    leadingIcon="help-outline"
                    title={t('preferences.faq')}
                    trailing={faqOpening ? busy : null}
                    onPress={openFaq}
                />
                {/* Never disabled while support opens: re-entry is guarded in useSupportAction. */}
                <Row
                    testID="settings-row-support"
                    leadingIcon="support-agent"
                    title={supportBusy ? t('support.opening') : t('preferences.support')}
                    trailing={supportBusy ? busy : null}
                    onPress={() => { void openSupport(); }}
                />
                {/* Every build; inert in dev (Sentry is off). */}
                <Row
                    testID="settings-row-report-bug"
                    leadingIcon="bug-report"
                    title={t('preferences.reportBug')}
                    onPress={() => showFeedback()}
                />
            </Group>

            <GroupLabel testID="settings-group-account">{t('settings.groupAccount')}</GroupLabel>
            <Group>
                {displayEmail ? (
                    <Row testID="settings-row-email" leadingIcon="mail-outline" title={maskEmail(displayEmail)} />
                ) : (
                    <Row
                        testID="settings-row-phone"
                        leadingIcon="smartphone"
                        title={t('you.settings.signedInPhone')}
                        subtitle={t('you.settings.noEmailNeeded')}
                    />
                )}
                {showMoveRow ? (
                    <Row
                        testID="settings-row-move-to-phone"
                        leadingIcon="smartphone"
                        title={t('moveToPhone.settingsRow')}
                        subtitle={t('moveToPhone.settingsRowHint', { date: emailCutoffLabel(i18n.language) })}
                        onPress={() => void requestMoveToPhone()}
                    />
                ) : null}
                <Row
                    testID="settings-row-restore-purchases"
                    leadingIcon="restore"
                    title={t('you.settings.restorePurchases')}
                    onPress={() => void restore()}
                    trailing={restoring ? busy : undefined}
                />
            </Group>
            {/* Under Restore purchases (owner mockup): where a plan lives and who sends receipts. */}
            <View style={{ paddingHorizontal: 4, paddingTop: 8, paddingBottom: 12, gap: 8 }}>
                <Text style={{ color: colors.ink3, fontSize: 13 }}>{t('subscription.platformSwitch')}</Text>
                <Text style={{ color: colors.ink3, fontSize: 13 }}>
                    {t(Platform.OS === 'ios' ? 'subscription.invoicesAppStore' : 'subscription.invoicesPlayStore')}
                </Text>
            </View>
            <Group>
                <Row
                    testID="settings-row-delete-account"
                    leadingIcon="delete-forever"
                    title={t('preferences.deleteAccount')}
                    titleColor={colors.negative}
                    subtitle={t('manageData.deleteAccountHint')}
                    onPress={() => void confirmDeleteAccount()}
                />
                <Row
                    testID="settings-row-logout"
                    leadingIcon="logout"
                    title={t('preferences.logout')}
                    titleColor={colors.negative}
                    onPress={() => { void confirmLogout(); }}
                    hideChevron
                />
            </Group>

            {devMode ? (
                <>
                    <GroupLabel testID="settings-group-developer">{t('you.settings.developer')}</GroupLabel>
                    <Group>
                        <Row
                            testID="settings-row-developer-mode"
                            leadingIcon="code"
                            title={t('you.settings.developerMode')}
                            subtitle={t('you.settings.developerHint')}
                            trailing={<Switch value={devMode} onToggle={(on: boolean) => void setDeveloperMode(on)} size="md" />}
                        />
                        <Row
                            testID="settings-row-observability"
                            leadingIcon="storage"
                            title={t('observability.title')}
                            subtitle={t('you.settings.observabilityHint')}
                            onPress={() => router.push('/logged-in/preferences/observability' as Href)}
                        />
                    </Group>
                </>
            ) : null}

            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' }}>
                    {link(t('preferences.privacyPolicy'), withAppLanguage(PRIVACY_URL), 'settings-link-privacy')}
                    {link(t('preferences.termsOfService'), withAppLanguage(TERMS_URL), 'settings-link-terms')}
                    {link(t('preferences.contentPolicy'), withAppLanguage(CONTENT_POLICY_URL), 'settings-link-content')}
                    {link(t('auth.sourceCode'), GITHUB_URL, 'settings-link-source-code')}
                </View>
                {/* Three taps here within 1.5 s toggle developer mode. */}
                <Pressable testID="settings-version" onPress={onVersionTap} accessible={false} style={{ minHeight: 44, justifyContent: 'center' }}>
                    <Text style={{ color: colors.ink3, fontSize: 12 }}>{versionText}</Text>
                </Pressable>
            </View>
        </View>
    );
};

export default AppPreferencesTab;