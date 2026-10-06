// Old route: a country's own article list was reachable only from the old
// country-first Sources screen, which is gone. A country's news is World's
// page for it now; old links open the World tab.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function CountryArticles() {
  return <PageRedirect page="world" />;
}
