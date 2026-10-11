// One interest, inside the Feed tab's stack.
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FactFeedScreen from '@/components/custom/for-you/FactFeedScreen';
import { useReportSurface } from '@/components/custom/nav/current-surface';
import { useLocalSearchParams } from 'expo-router';

export default function InterestRoute() {
  const { factId, statement, via } = useLocalSearchParams<{
    factId?: string;
    statement?: string;
    via?: string;
  }>();
  useReportSurface(`interest:${factId ?? ''}`);
  return (
    <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
      <FactFeedScreen factId={factId ?? ''} statement={statement ?? ''} arrivedFromNext={via === 'next'} />
    </ErrorBoundary>
  );
}
