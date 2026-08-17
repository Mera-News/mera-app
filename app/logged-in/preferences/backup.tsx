import BackupScreen from '@/components/custom/backup/BackupScreen';
import { useRouter } from 'expo-router';

export default function BackupPage() {
    const router = useRouter();

    return <BackupScreen onBack={() => router.back()} />;
}
