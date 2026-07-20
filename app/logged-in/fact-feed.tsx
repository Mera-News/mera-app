// Routing only — the full feed for a single fact (Round-3 C2).
import FactFeedScreen from '@/components/custom/for-you/FactFeedScreen';
import { useLocalSearchParams } from 'expo-router';

export default function FactFeedRoute() {
  const { factId, statement } = useLocalSearchParams<{ factId?: string; statement?: string }>();
  return <FactFeedScreen factId={factId ?? ''} statement={statement ?? ''} />;
}
