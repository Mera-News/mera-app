import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import DisplaySettingsScreen from '@/components/custom/config-mera/DisplaySettingsScreen';
import { useRouter } from 'expo-router';

export default function DisplayPage() {
  const router = useRouter();

  return (
    // S7: a crash here stays on this page instead of reaching the root
    // boundary, which swaps the whole app for a fallback.
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <DisplaySettingsScreen onBack={() => router.back()} />
    </ErrorBoundary>
  );
}
