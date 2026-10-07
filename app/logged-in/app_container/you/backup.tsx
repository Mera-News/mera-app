// Settings > Your data > Backup, inside the You stack (FinalBackup).
import BackupSection from '@/components/custom/backup/BackupSection';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

export default function BackupRoute() {
  const { t } = useTranslation();
  const { restore } = useLocalSearchParams<{ restore?: string }>();
  // Latched on FIRST read: the param stays on the route, and cancelling out
  // of the restore steps must not reopen them on the next render.
  const [autoOpenRecover] = useState(restore === '1');
  return (
    <TabStackScreen surface="settings:backup" backdrop testID="backup-screen">
      <DrillDownHeader title={t('backup.title')} onBack={() => router.back()} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 48 }}>
        <BackupSection autoOpenRecover={autoOpenRecover} />
      </ScrollView>
    </TabStackScreen>
  );
}
