// Old route: Profile is a page of the You tab now. Kept so old links open it.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function ConfigPanel() {
  return <PageRedirect page="profile" />;
}
