import ManageDataScreen from '@/components/custom/config-mera/ManageDataScreen';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';

export default function ManageDataPage() {
    const router = useRouter();
    const { restore } = useLocalSearchParams<{ restore?: string }>();

    // Latched on FIRST read, because the param stays on the route: without this
    // a user who cancels out of the recovery flow and navigates back here would
    // be dropped straight into it again. Settings > "Restore from a backup" is
    // what sets it.
    const [autoOpenRecover] = useState(restore === '1');

    return <ManageDataScreen onBack={() => router.back()} autoOpenRecover={autoOpenRecover} />;
}
