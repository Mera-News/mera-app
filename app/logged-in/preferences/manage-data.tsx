// Your data and Backup live in the You stack now. Kept so old links still
// work: `manage-data?restore=1` (emails, the site) opens Backup on its
// restore steps; anything else opens Your data.
import { TabScreenRedirect } from '@/components/custom/nav/LegacyRedirect';
import { useLocalSearchParams } from 'expo-router';

export default function ManageDataRedirect() {
  const { restore } = useLocalSearchParams<{ restore?: string }>();
  return restore === '1' ? (
    <TabScreenRedirect tab="you" screen="backup" params={{ restore: '1' }} />
  ) : (
    <TabScreenRedirect tab="you" screen="data" />
  );
}
