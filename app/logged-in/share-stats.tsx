// Old route: the Stats are the Library's Stats page now (sharing happens in
// place there). Kept so old links and restored screens land on it (any `card`
// param is dropped).
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function ShareStats() {
  return <PageRedirect page="stats" />;
}
