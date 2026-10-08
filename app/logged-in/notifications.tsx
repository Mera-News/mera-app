import { PageRedirect } from '@/components/custom/nav/LegacyRedirect';

/** Old links and restored navigation: notices live in Feed > Notifications. */
export default function NotificationsRedirect() {
    return <PageRedirect page="notifications" />;
}
