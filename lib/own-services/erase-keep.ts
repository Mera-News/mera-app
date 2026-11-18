import { getSettingsByPrefix } from '@/lib/database/services/setting-service';

/** Device keys the client's own list lacks. Each one stays so the phone does not act as if it were new. */
export const APP_KEEP_SETTING_KEYS: readonly string[] = [
  // Developer switch of this phone.
  'developer_mode',
  // Update bookkeeping: erased, the same update would be announced again.
  'ota_last_running_update',
  'ota_update_noticed_id',
  // Erased, an old notification would be handled again.
  'last_handled_notification_id',
  // One-time notes this phone has already shown.
  'invoices_note_shown',
  'feed_privacy_intro_dismissed',
  // Foreground time of this phone, used by the lock and the restart rules.
  'last_foreground_at',
  // The model and where chat runs: chats stay on this phone, so do their choices.
  'mera_selected_model_id',
  'mera_chat_in_cloud',
  // Written after the erase; a second pairing must not clear it before a backup or restore does.
  'backup_held_after_pairing',
];

/** Keys the erase removes on purpose. Anything the app writes must be kept, served, or named here. */
export const ERASED_ON_PURPOSE: readonly string[] = [
  // Tied to the person's notification setup, which the server's data replaces.
  'pending_notification_hours',
  // Hashes of the server's tables as this phone last saw them: none apply to the new server.
  'pod_sync_hashes',
  // A stashed notification tap and two latches about screens, all stale after a restart.
  'pending_notification_route',
  'feed_privacy_intro_session',
  'stories_page_opened',
];

/** The app's keep list for the erase: the fixed keys and every tutorial key the phone holds now. */
export async function appKeepSettingKeys(): Promise<string[]> {
  return [...APP_KEEP_SETTING_KEYS, ...Object.keys(await getSettingsByPrefix('tutorial_'))];
}
