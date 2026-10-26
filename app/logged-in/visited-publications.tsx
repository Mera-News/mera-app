// Old route: History is a screen in the Library stack now. Kept so old links
// and restored screens still open it there.
import { TabScreenRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function LegacyRoute() {
  return <TabScreenRedirect tab="library" screen="history" />;
}
