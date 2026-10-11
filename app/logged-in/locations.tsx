// Moved into the You tab's stack (navx). Kept so old links and restored
// screens still open it there.
import { TabScreenRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function LegacyRoute() {
  return <TabScreenRedirect tab="you" screen="locations" />;
}
