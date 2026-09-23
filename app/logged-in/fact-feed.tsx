// Routing only — the full feed for a single fact (Round-3 C2).
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FactFeedScreen from '@/components/custom/for-you/FactFeedScreen';
import { useLocalSearchParams } from 'expo-router';

export default function FactFeedRoute() {
  const { factId, statement } = useLocalSearchParams<{ factId?: string; statement?: string }>();
  return (
    // S7: a crash here stays on this page instead of reaching the root
    // boundary, which swaps the whole app for a fallback.
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <FactFeedScreen factId={factId ?? ''} statement={statement ?? ''} />
    </ErrorBoundary>
  );
}
