// Notification-Center Service — WatermelonDB adapter for persona-v3
// `notifications`. One surface for every app-side notification (calibration,
// hygiene, migration_done, sync events, …). NOT the OS push-notification
// plumbing — that stays in lib/notification-service.ts. TTL 90d via
// `deleteOlderThan` (data-cleanup-task).

import { Q } from '@nozbe/watermelondb';
import { distinctUntilChanged } from 'rxjs';
import database from '../index';
import type NotificationModel from '../models/Notification';

const notificationsCollection = database.get<NotificationModel>('notifications');

export interface NotifyInput {
  type: string;
  title: string;
  body: string;
  icon?: string | null;
  /** Payload handed to chat on tap-through. */
  context?: Record<string, unknown> | null;
  /** Option chips, e.g. [{ id: 'recalibrate', labelKey: '…' }]. */
  actions?: { id: string; labelKey?: string; label?: string }[] | null;
  source: string;
}

/** Creates an unread notification row. Returns the record. */
export async function notify(input: NotifyInput): Promise<NotificationModel> {
  return database.write(async () => {
    return notificationsCollection.create((n) => {
      n.type = input.type;
      n.title = input.title;
      n.body = input.body;
      n.icon = input.icon ?? null;
      n.contextJson = input.context ? JSON.stringify(input.context) : null;
      n.actionsJson = input.actions ? JSON.stringify(input.actions) : null;
      n.status = 'unread';
      n.source = input.source;
      n.createdAt = new Date();
    });
  });
}

async function setStatus(
  notificationId: string,
  status: 'read' | 'actioned' | 'dismissed',
): Promise<void> {
  const record = await notificationsCollection.find(notificationId);
  await database.write(async () => {
    await record.update((n) => {
      n.status = status;
    });
  });
}

export async function markRead(notificationId: string): Promise<void> {
  await setStatus(notificationId, 'read');
}

export async function markActioned(notificationId: string): Promise<void> {
  await setStatus(notificationId, 'actioned');
}

export async function dismiss(notificationId: string): Promise<void> {
  await setStatus(notificationId, 'dismissed');
}

/** Reactive unread count — drives the bell badge. */
export function observeUnreadCount() {
  return notificationsCollection
    .query(Q.where('status', 'unread'))
    .observeCount()
    .pipe(distinctUntilChanged());
}

/** Reactive list, newest first — drives the notification panel. */
export function observeAll(limit = 100) {
  return notificationsCollection
    .query(Q.sortBy('created_at', Q.desc), Q.take(limit))
    .observe();
}

export async function getAll(limit = 100): Promise<NotificationModel[]> {
  return notificationsCollection
    .query(Q.sortBy('created_at', Q.desc), Q.take(limit))
    .fetch();
}

/** Deletes notifications created before the cutoff. Returns deleted count. */
export async function deleteOlderThan(cutoffMs: number): Promise<number> {
  const old = await notificationsCollection
    .query(Q.where('created_at', Q.lt(cutoffMs)))
    .fetch();
  if (old.length === 0) return 0;
  await database.write(async () => {
    await database.batch(old.map((r) => r.prepareDestroyPermanently()));
  });
  return old.length;
}
