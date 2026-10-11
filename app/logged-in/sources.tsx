// Old route: the country-first Sources screen is gone; publication
// preferences live in You > Sources. Kept so old links open it there.
import { TabScreenRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function LegacyRoute() {
  return <TabScreenRedirect tab="you" screen="sources" />;
}
