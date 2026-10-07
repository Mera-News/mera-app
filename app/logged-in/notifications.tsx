import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

/** Old links and restored navigation: notices live in You > Notifications. */
export default function NotificationsRedirect() {
    return <PageRedirect page="notifications" />;
}
