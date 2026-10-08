// Settings > App lock, inside the You stack: the PIN switch, Change PIN and
// the Forgot your PIN line (FinalSettings #12). The PIN flows open over it.
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import SecuritySettingsSection from '@/components/custom/config-mera/SecuritySettingsSection';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { useTabContentBottomInset } from '@/lib/navigation/tab-bar';

export default function AppLockRoute() {
  const bottomInset = useTabContentBottomInset();
  const { t } = useTranslation();
  return (
    <TabStackScreen surface="settings:app-lock" backdrop testID="app-lock-screen">
      <DrillDownHeader title={t('you.settings.appLock')} onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: bottomInset }}>
        <SecuritySettingsSection />
      </ScrollView>
    </TabStackScreen>
  );
}
