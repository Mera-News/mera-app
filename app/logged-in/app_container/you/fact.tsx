// One fact, inside the You tab's stack (Profile > Facts > a fact).
import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import FactPage from '@/components/custom/facts/FactPage';
import TabStackScreen from '@/components/custom/nav/TabStackScreen';
import { useLocalSearchParams } from 'expo-router';

export default function FactRoute() {
  const { factId, statement } = useLocalSearchParams<{ factId?: string; statement?: string }>();
  return (
    <TabStackScreen surface="facts" testID="fact-page">
      <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
        <FactPage factId={factId ?? ''} statement={statement ?? ''} from="you" />
      </ErrorBoundary>
    </TabStackScreen>
  );
}
