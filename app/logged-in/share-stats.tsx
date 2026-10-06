// Old route: the share cards are the Stats page of the Library tab now. Kept
// so old links and restored screens open it there, on the card they named.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';
import { useLocalSearchParams } from 'expo-router';

export default function ShareStats() {
  const { card } = useLocalSearchParams<{ card?: string }>();
  return <PageRedirect page="stats" params={card ? { card } : undefined} />;
}
