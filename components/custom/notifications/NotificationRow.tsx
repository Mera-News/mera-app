import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { ToneBadge } from '@/components/custom/toast/MeraToast';
import { noticeLook } from '@/components/custom/toast/notice-tone';
import type NotificationModel from '@/lib/database/models/Notification';
import { deleteNotification } from '@/lib/database/services/notification-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { tint, useColors } from '@/lib/theme/tokens';
import type { TFunction } from 'i18next';
import { Trash } from 'lucide-react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text, View } from 'react-native';
import Animated, { FadeOut } from 'react-native-reanimated';
import { FEEDBACK_REQUEST, parseJson, resolveText, tapNotification } from './notification-actions';

/** "now" / "5m" / "2h" / "3d", as the board draws it, in the app language. */
export function relativeTime(t: TFunction<'translation'>, date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (mins < 1) return t('notificationCenter.ageNow');
    if (mins < 60) return t('notificationCenter.ageMinutes', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('notificationCenter.ageHours', { n: hours });
    return t('notificationCenter.ageDays', { n: Math.floor(hours / 24) });
}

export const ROW_RADIUS = 18;
const BADGE = 32;
const DOT = 9;
const DOT_EDGE = 2;
const DELETE_FRAME = 44;
const DELETE_GLYPH = 18;
const PAD_Y = 14;

interface NotificationRowProps {
    readonly n: NotificationModel;
    /** First and last rows round the grouped plate's corners. */
    readonly first: boolean;
    readonly last: boolean;
    /** Lite / Reduce Motion: a deleted row leaves at once. */
    readonly motion: boolean;
}

/**
 * One inbox row (design "Notifications inbox"): the notice's tone badge (the
 * same tone and glyph as its toast, `noticeLook`), its title with the age at
 * the right, up to two lines of body, and a delete at the end. Unread is a
 * semibold title plus a dot on the badge, and "unread" in the spoken label,
 * since VoiceOver cannot see the dot. Rows stack into one grouped plate: an
 * opaque panel (paper in light), a 1pt edge, hairline dividers.
 */
export default function NotificationRow({ n, first, last, motion }: NotificationRowProps) {
    const { t } = useTranslation();
    const c = useColors();
    const params = parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
    // A feedback request's body is free text: never through t(), whose
    // separators would mangle a question.
    const body = (n.type === FEEDBACK_REQUEST ? n.body : resolveText(n.body, params)).trim();
    const ownTitle = resolveText(n.title, params).trim();
    // A row is never blank: no title shows the body's first line as the title, and no preview.
    const title = ownTitle || body.split('\n')[0].trim();
    const preview = ownTitle ? body : '';
    const age = relativeTime(t, n.createdAt);
    const unread = n.status === 'unread';
    const look = noticeLook(n.type, params);
    const heading = unread ? t('notificationCenter.rowUnreadA11y', { title, age }) : `${title}, ${age}`;

    return (
        <Animated.View
            exiting={motion ? FadeOut.duration(180) : undefined}
            style={{
                marginHorizontal: PAGE_SIDE_INSET,
                backgroundColor: c.panel,
                borderColor: c.line,
                borderTopColor: first ? c.line : tint(c.ink, 0.08),
                borderLeftWidth: 1,
                borderRightWidth: 1,
                borderTopWidth: 1,
                borderBottomWidth: last ? 1 : 0,
                borderTopLeftRadius: first ? ROW_RADIUS : 0,
                borderTopRightRadius: first ? ROW_RADIUS : 0,
                borderBottomLeftRadius: last ? ROW_RADIUS : 0,
                borderBottomRightRadius: last ? ROW_RADIUS : 0,
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 12,
                paddingRight: 4,
            }}
        >
            <Pressable
                testID={`notification-row-${n.id}`}
                onPress={() => {
                    void hapticLight();
                    void tapNotification(n);
                }}
                accessibilityRole="button"
                accessibilityLabel={preview ? `${heading}. ${preview}` : heading}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: PAD_Y, paddingLeft: 14 }}
            >
                <View style={{ width: BADGE, height: BADGE }}>
                    <ToneBadge tone={look.tone} icon={look.icon} size={BADGE} />
                    {unread ? (
                        <View
                            testID={`notification-unread-${n.id}`}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={{
                                position: 'absolute',
                                top: -1,
                                right: -1,
                                width: DOT + 2 * DOT_EDGE,
                                height: DOT + 2 * DOT_EDGE,
                                borderRadius: (DOT + 2 * DOT_EDGE) / 2,
                                borderWidth: DOT_EDGE,
                                borderColor: c.panel,
                                backgroundColor: c.accent,
                            }}
                        />
                    ) : null}
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2, paddingTop: 5 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                        <Text
                            numberOfLines={1}
                            style={{ flex: 1, minWidth: 0, color: c.ink, fontSize: 15, lineHeight: 20, fontWeight: unread ? '600' : '400' }}
                        >
                            {title}
                        </Text>
                        <Text style={{ color: c.ink3, fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] }}>{age}</Text>
                    </View>
                    {preview ? (
                        <Text numberOfLines={2} style={{ color: c.ink2, fontSize: 14, lineHeight: 20 }}>
                            {preview}
                        </Text>
                    ) : null}
                </View>
            </Pressable>
            {/* A sibling of the row's press area, never inside it, so a delete never opens the row. */}
            <Pressable
                testID={`notification-delete-${n.id}`}
                onPress={() => {
                    void hapticLight();
                    deleteNotification(n.id).catch((err: unknown) =>
                        logger.captureException(err, { tags: { component: 'NotificationRow', method: 'delete' } }),
                    );
                }}
                accessibilityRole="button"
                accessibilityLabel={t('common.delete')}
                // The 44pt frame sits 6pt above the text's top line, as drawn.
                style={{ width: DELETE_FRAME, height: DELETE_FRAME, marginTop: PAD_Y - 6, alignItems: 'center', justifyContent: 'center' }}
            >
                <Trash size={DELETE_GLYPH} color={c.ink3} strokeWidth={2} />
            </Pressable>
        </Animated.View>
    );
}
