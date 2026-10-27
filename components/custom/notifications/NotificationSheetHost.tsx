import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { noticeLook } from '@/components/custom/toast/notice-tone';
import { APP_UPDATED, RESTART_FOR_UPDATE, UPDATE_AVAILABLE, useOpenUpdateNotes } from '@/lib/ota-notice';
import { tint, useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import NotificationSheet from './NotificationSheet';
import { relativeTime } from './NotificationRow';
import { parseJson, resolveText, runNotificationAction, useNotificationSheet } from './notification-actions';

const NOTES = noticeLook(APP_UPDATED);
const UPDATE = noticeLook(UPDATE_AVAILABLE);

/**
 * The notification sheets, mounted ONCE in the logged-in layout so they open
 * wherever the reader is: What's new opens from an App updated row AND from the
 * "Mera updated" toast's See what's new (which fires after a reload, usually
 * far from the inbox); Update ready opens from an update_available row.
 * Renders nothing while both are closed.
 */
export default function NotificationSheetHost() {
    const { t, i18n } = useTranslation();
    const c = useColors();
    const { height } = useWindowDimensions();
    const notes = useOpenUpdateNotes();
    const { updateReady, updateReadyOpen, notesAt } = useNotificationSheet();
    const params = parseJson<Record<string, unknown>>(updateReady?.contextJson ?? null) ?? undefined;

    return (
        <>
            <NotificationSheet
                testID="update-notes"
                open={notes.open}
                onClose={() => useOpenUpdateNotes.setState({ open: false })}
                onClosed={() => useNotificationSheet.setState({ notesAt: null })}
                tone={NOTES.tone}
                icon={NOTES.icon}
                title={t('notificationCenter.update.notesTitle')}
                // From the toast it has just happened.
                age={relativeTime(t, notesAt ?? new Date())}
                actions={[{ label: t('common.done'), onPress: () => {}, testID: 'update-notes-done' }]}
            >
                {notes.notes.length === 0 ? (
                    <Text style={{ color: c.ink, fontSize: 16, lineHeight: 24 }}>{t('notificationCenter.update.notesEmpty')}</Text>
                ) : (
                    // Up to 10 notes: the sheet does not scroll for you.
                    // A note scrolled into view asks for its translation on a tick.
                    <ScrollView
                        style={{ maxHeight: height * 0.5 }}
                        contentContainerStyle={{ gap: 16 }}
                        onScroll={notifyScrollTick}
                        onContentSizeChange={notifyScrollTick}
                        scrollEventThrottle={16}
                    >
                        {notes.notes.map((note, i) => (
                            <View
                                key={note.at}
                                style={{
                                    gap: 4,
                                    paddingBottom: i < notes.notes.length - 1 ? 16 : 0,
                                    borderBottomWidth: i < notes.notes.length - 1 ? 1 : 0,
                                    borderBottomColor: tint(c.ink, 0.08),
                                }}
                            >
                                <Text style={{ color: c.ink3, fontSize: 13, lineHeight: 18 }}>
                                    {new Date(note.at).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}
                                </Text>
                                {/* Release notes are free text: never through t(). */}
                                <TranslatableDynamic text={note.message} style={{ color: c.ink, fontSize: 16, lineHeight: 24 }} />
                            </View>
                        ))}
                    </ScrollView>
                )}
            </NotificationSheet>
            <NotificationSheet
                testID="update-ready"
                open={updateReadyOpen}
                onClose={() => useNotificationSheet.setState({ updateReadyOpen: false })}
                onClosed={() => useNotificationSheet.setState({ updateReady: null })}
                tone={UPDATE.tone}
                icon={UPDATE.icon}
                title={resolveText(updateReady?.title ?? 'notificationCenter.update.availableTitle', params)}
                age={updateReady ? relativeTime(t, updateReady.createdAt) : undefined}
                body={resolveText(updateReady?.body ?? 'notificationCenter.update.availableBody', params)}
                actions={[
                    {
                        label: t('notificationCenter.update.restart'),
                        primary: true,
                        testID: 'update-ready-restart',
                        onPress: () => {
                            if (updateReady) void runNotificationAction(updateReady, { id: RESTART_FOR_UPDATE });
                        },
                    },
                    { label: t('notificationCenter.update.notNow'), onPress: () => {}, testID: 'update-ready-not-now' },
                ]}
            />
        </>
    );
}
