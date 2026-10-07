// Old route: the Stats live under the Library's History page now. Kept so old
// links and restored screens land there (any `card` param is dropped).
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function ShareStats() {
  return <PageRedirect page="visited" />;
}
