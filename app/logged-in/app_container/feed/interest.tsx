// One interest, inside the Feed tab's stack: the ONE fact page (You area),
// opened from a sectioned header, starting on Recent articles with Next
// interest at its end.
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FactPage from '@/components/custom/facts/FactPage';
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
      <FactPage factId={factId ?? ''} statement={statement ?? ''} from="feed" arrivedFromNext={via === 'next'} />
    </ErrorBoundary>
  );
}
