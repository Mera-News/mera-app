// Old route: One interest lives inside the Feed tab's stack now
// (app_container/feed/interest). Kept so old links and restored screens open it.
import { TabScreenRedirect } from '@/components/custom/nav/LegacyRedirect';
import { useLocalSearchParams } from 'expo-router';

export default function FactFeedRoute() {
  const { factId, statement, via } = useLocalSearchParams<{
    factId?: string;
    statement?: string;
    via?: string;
  }>();
  const params: Record<string, string> = {};
  if (factId) params.factId = factId;
  if (statement) params.statement = statement;
  if (via) params.via = via;
  return <TabScreenRedirect tab="feed" screen="interest" params={params} />;
}
