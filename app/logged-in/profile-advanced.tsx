// Old route: the Advanced hub became the Profile page of the You tab (its
// cards and View-all screens). Kept so old links open it there.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function ProfileAdvanced() {
  return <PageRedirect page="profile" />;
}
