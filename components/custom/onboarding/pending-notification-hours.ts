// Notification hours chosen while offline (or when the server call failed) wait here until a call lands.
// The wizard writes them at finish; `flushPendingNotificationHours` runs right after, and from the launch
// reconcile next to reconcileAppLanguageWithPersona. Never throws.
import { AccountService } from '@/lib/account-service';
import { convertLocalHoursToUTC } from '@/lib/algorithms/notificationSlotUtils';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { isOnline } from '@/lib/stores/network-store';

export const PENDING_HOURS_SETTING_KEY = 'pending_notification_hours';

/** Local hours as the wizard holds them; stored as UTC, the form the server takes. */
export async function savePendingNotificationHours(localHours: number[]): Promise<void> {
    if (localHours.length === 0) return;
    try {
        await setSetting(PENDING_HOURS_SETTING_KEY, JSON.stringify(convertLocalHoursToUTC(localHours)));
    } catch (error) {
        logger.warn('[onboarding] could not keep notification hours', { error: String(error) });
    }
}

export async function flushPendingNotificationHours(userId: string): Promise<void> {
    try {
        const raw = await getSetting(PENDING_HOURS_SETTING_KEY);
        if (!raw || !isOnline()) return;
        const hours: unknown = JSON.parse(raw);
        if (!Array.isArray(hours) || hours.length === 0) {
            await deleteSetting(PENDING_HOURS_SETTING_KEY);
            return;
        }
        await AccountService.updateNotificationPreferences(userId, hours as number[]);
        await deleteSetting(PENDING_HOURS_SETTING_KEY);
    } catch (error) {
        logger.warn('[onboarding] notification hours not sent yet', { error: String(error) });
    }
}
