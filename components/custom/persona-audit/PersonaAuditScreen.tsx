import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Group, GroupLabel } from '@/components/custom/you/rows';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type PersonaChangeLogModel from '@/lib/database/models/PersonaChangeLog';
import { observeRecent, revertChange } from '@/lib/database/services/persona-change-log-service';
import { showDialog } from '@/lib/dialog';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { notifyScrollTick } from '@/lib/visibility-tick';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import { actionDisplay, isRevertible, sourceLabelKey } from './action-display';

interface PersonaAuditScreenProps {
    readonly onBack: () => void;
}

interface Day {
    readonly label: string;
    readonly rows: PersonaChangeLogModel[];
}

/** Day headers: Today, then the date in the app language. */
function dayLabel(date: Date, today: string, language: string | undefined): string {
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return today;
    try {
        return date.toLocaleDateString(language, { day: 'numeric', month: 'long' });
    } catch {
        return date.toLocaleDateString();
    }
}

/**
 * Changes to your profile (FinalProfile #16): every change in plain words,
 * by day, each with its source and age, and Undo where it can be undone
 * (behind a confirm). Not every change can be: deleting a fact or a place
 * has no inverse (`isRevertible`).
 */
const PersonaAuditScreen: React.FC<PersonaAuditScreenProps> = ({ onBack }) => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const [rows, setRows] = useState<PersonaChangeLogModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [revertingId, setRevertingId] = useState<string | null>(null);

    // Reactive newest-first log. revertChange flips `reverted` and appends a
    // `revert_change` row, both of which arrive through this same subscription.
    useEffect(() => {
        const sub = observeRecent(100).subscribe((next) => {
            setRows(next);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const days: Day[] = useMemo(() => {
        const out: Day[] = [];
        for (const row of rows) {
            const label = dayLabel(row.createdAt, t('common.today'), i18n?.language);
            const last = out[out.length - 1];
            if (last && last.label === label) last.rows.push(row);
            else out.push({ label, rows: [row] });
        }
        return out;
    }, [rows, t, i18n?.language]);

    const undo = useCallback(
        async (row: PersonaChangeLogModel) => {
            const ok = await showDialog({
                title: t('personaAudit.revertConfirmTitle'),
                body: row.summary ? `${t('personaAudit.revertConfirmBody')}\n\n${row.summary}` : t('personaAudit.revertConfirmBody'),
                confirmLabel: t('personaAudit.revertConfirmCta'),
                cancelLabel: t('common.cancel'),
            });
            if (!ok) return;
            setRevertingId(row.id);
            void hapticLight();
            try {
                await revertChange(row.id);
                toastManager.showSuccess(t('personaAudit.revertSuccessTitle'), t('personaAudit.revertSuccessBody'));
            } catch (error) {
                // revertChange throws for action types with no inverse yet, or if
                // the target row is gone. The list is unchanged (reactive).
                logger.captureException(error, {
                    tags: { component: 'PersonaAuditScreen', method: 'revertChange' },
                    extra: { changeLogId: row.id, actionType: row.actionType },
                });
                toastManager.showError(t('personaAudit.revertFailedTitle'), t('personaAudit.revertFailedBody'));
            } finally {
                setRevertingId(null);
            }
        },
        [t],
    );

    const renderRow = (row: PersonaChangeLogModel) => {
        const reverted = row.reverted;
        const canUndo = !reverted && isRevertible(row.actionType);
        const source = t(`personaAudit.sources.${sourceLabelKey(row.source)}` as never);
        const meta = [source, reverted ? t('personaAudit.revertedBadge') : null, formatTimeAgo(t, row.createdAt.getTime())]
            .filter(Boolean)
            .join(' · ');
        return (
            <View
                key={row.id}
                testID={`persona-audit-row-${row.id}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16 }}
            >
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <TranslatableDynamic
                        text={row.summary || t(`personaAudit.actionLabels.${actionDisplay(row.actionType).labelKey}` as never)}
                        size="md"
                        style={{ color: reverted ? colors.ink3 : colors.ink, textDecorationLine: reverted ? 'line-through' : 'none' }}
                        numberOfLines={3}
                    />
                    <Text style={{ color: colors.ink2, fontSize: 13 }}>{meta}</Text>
                </View>
                {canUndo ? (
                    revertingId === row.id ? (
                        <Spinner size="small" />
                    ) : (
                        <Pressable
                            testID={`persona-audit-revert-${row.id}`}
                            onPress={() => undo(row)}
                            accessibilityRole="button"
                            accessibilityLabel={t('articleMenu.undo')}
                            style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('articleMenu.undo')}</Text>
                        </Pressable>
                    )
                ) : null}
            </View>
        );
    };

    const renderDay = ({ item }: { item: Day }) => (
        <View style={{ marginHorizontal: 14 }}>
            <GroupLabel>{item.label}</GroupLabel>
            <Group>{item.rows.map(renderRow)}</Group>
        </View>
    );

    return (
        <View style={{ flex: 1 }}>
            <DrillDownHeader title={t('personaAudit.title')} onBack={onBack} />
            {isLoading ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Spinner size="large" />
                </View>
            ) : rows.length === 0 ? (
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, marginHorizontal: 18, marginTop: 16 }}>
                    {t('personaAudit.empty')}
                </Text>
            ) : (
                <FlatList
                    // Rows below the first screen ask for their translation only
                    // when a scroll tick finds them on screen (lib/visibility-tick).
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    onContentSizeChange={notifyScrollTick}
                    data={days}
                    keyExtractor={(day) => day.label}
                    renderItem={renderDay}
                    contentContainerStyle={{ paddingBottom: 120 }}
                    showsVerticalScrollIndicator={false}
                />
            )}
        </View>
    );
};

export default PersonaAuditScreen;
