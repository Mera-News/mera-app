// The Not interested page is gone: turning topics down lives in each fact's
// page (Show less of). Kept so old links and restored screens land on Profile.
import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

export default function LegacyRoute() {
  return <PageRedirect page="profile" />;
}
