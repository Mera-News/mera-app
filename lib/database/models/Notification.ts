import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * Persona v3 notification center row — one surface for all app-side
 * notifications (calibration, hygiene, migration_done, sync events, …).
 * `title`/`body` are i18n keys (+ params in context_json) for system types or
 * freeform for agent types. `context_json` is handed to chat on tap;
 * `actions_json` renders option chips. TTL 90d, pruned by data-cleanup-task.
 */
export type NotificationStatus = 'unread' | 'read' | 'dismissed' | 'actioned';

export default class Notification extends Model {
  static table = 'notifications';

  @field('type') type!: string;
  @text('title') title!: string;
  @text('body') body!: string;
  @field('icon') icon!: string | null;
  @text('context_json') contextJson!: string | null;
  @text('actions_json') actionsJson!: string | null;
  @field('status') status!: NotificationStatus;
  @field('source') source!: string;
  @date('created_at') createdAt!: Date;
}
