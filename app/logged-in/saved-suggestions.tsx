// Old route: this is a page of the Library tab now. Kept so old links and
// restored screens still open it there.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function LegacyRoute() {
  return <PageRedirect page="saved" />;
}
