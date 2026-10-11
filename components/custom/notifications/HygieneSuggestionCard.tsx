// Tidy-up suggestions as cards at the top of Feed > Notifications (owner: one
// card per suggestion, Accept and Dismiss on the card; the Tidy up screen and
// its Profile row are gone). Each card says what the suggestion is and what
// accepting does; nothing changes until the reader chooses. A duplicate offers
// Merge (behind a confirm: it deletes the second fact for good) or Keep both.
import { sentenceCase } from '@/components/custom/facts/sentence-case';
import { PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { useHubFacts } from '@/components/custom/you/use-hub-data';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import {
    acceptProposal,
    getPendingProposals,
    rejectProposal,
    subscribeHygieneChange,
} from '@/lib/database/services/hygiene-service';
import { showDialog } from '@/lib/dialog';
import { hapticLight } from '@/lib/haptics';
import { showCloudOnlyNotice } from '@/lib/llm/cloud-only-notice';
import logger from '@/lib/logger';
import type { HygieneProposal, HygieneProposalKind } from '@/lib/news-harness/persona-management/fact-hygiene';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';
import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/** What each kind of suggestion is, in a title (FinalProfile #14). */
function titleForKind(kind: HygieneProposalKind, t: TFunction): string {
    switch (kind) {
        case 'duplicate_facts':
            return t('hygiene.titleDuplicate');
        case 'too_broad_fact':
            return t('hygiene.titleTooBroad');
        case 'stale_topic':
            return t('hygiene.titleStaleTopic');
        case 'stale_fact':
            return t('hygiene.titleStaleFact');
        case 'location_conflict':
            return t('hygiene.titleLocationConflict');
        default:
            return t('hygiene.titleIncoherentTopics');
    }
}

/** The one-line "what happens if you accept" preview per kind. */
function effectPreview(kind: HygieneProposalKind, t: TFunction): string {
    switch (kind) {
        case 'duplicate_facts':
            // C2: the second fact is deleted; no topics move and there is no undo.
            return t('hygiene.mergeNote');
        case 'too_broad_fact':
            return t('hygiene.effectTooBroad');
        case 'stale_topic':
            return t('hygiene.effectStaleTopic');
        case 'stale_fact':
            return t('hygiene.effectStaleFact');
        case 'incoherent_topics':
            return t('hygiene.effectIncoherentTopics');
        case 'location_conflict':
            return t('hygiene.effectLocationConflict');
        default:
            return '';
    }
}

/**
 * The suggestion in one line, naming its facts or topics. Null for a proposal
 * saved before `subject` existed: the title and effect line still say what it is.
 */
function summaryFor(item: HygieneProposal, t: TFunction): string | null {
    const subject = item.subject as HygieneProposal['subject'] | undefined;
    if (!subject) return null;
    const [fact = '', other = ''] = subject.facts;
    switch (item.kind) {
        case 'duplicate_facts':
            return t('hygiene.summary.duplicate', { fact, other });
        case 'location_conflict':
            return t('hygiene.summary.locationConflict', { fact, other });
        case 'stale_fact':
            return t('hygiene.summary.staleFact', { fact });
        case 'too_broad_fact':
            return t('hygiene.summary.tooBroad', { fact });
        case 'stale_topic':
            return t('hygiene.summary.staleTopic', { topic: subject.topics[0] ?? '' });
        case 'incoherent_topics':
            return t('hygiene.summary.incoherentTopics', {
                count: subject.topics.length,
                fact,
                topics: subject.topics.join(', '),
            });
        default:
            return null;
    }
}

const ActionButton: React.FC<{
    readonly label: string;
    readonly onPress: () => void;
    readonly filled?: boolean;
    readonly disabled: boolean;
    readonly testID: string;
}> = ({ label, onPress, filled = false, disabled, testID }) => {
    const colors = useColors();
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            // Disabled is neutral grey, never a dimmed accent (components/ui/button).
            style={{
                flex: 1,
                height: 44,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: filled ? (disabled ? colors.surfaceRaised : colors.accent) : 'transparent',
                borderWidth: filled ? 0 : 1,
                borderColor: disabled ? colors.line : colors.trackBorder,
            }}
        >
            <Text style={{ color: disabled ? colors.ink3 : filled ? colors.onAccent : colors.ink, fontSize: 15, fontWeight: '600' }}>
                {label}
            </Text>
        </Pressable>
    );
};

/** The pending suggestions, live, with Accept and Dismiss. */
export function useHygieneSuggestions() {
    const { t } = useTranslation();
    const [items, setItems] = useState<HygieneProposal[]>([]);
    const [actingId, setActingId] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setItems(await getPendingProposals());
        } catch (error) {
            logger.captureException(error, { tags: { component: 'HygieneSuggestionCard', method: 'load' } });
        }
    }, []);

    useEffect(() => {
        void load();
        return subscribeHygieneChange(() => void load());
    }, [load]);

    const accept = useCallback(
        async (proposal: HygieneProposal) => {
            if (actingId) return;
            if (proposal.kind === 'duplicate_facts') {
                const ok = await showDialog({
                    title: t('hygiene.titleDuplicate'),
                    body: t('hygiene.mergeNote'),
                    confirmLabel: t('hygiene.merge'),
                    cancelLabel: t('common.cancel'),
                    destructive: true,
                });
                if (!ok) return;
            }
            setActingId(proposal.id);
            void hapticLight();
            // Optimistic: drop the card immediately.
            setItems((prev) => prev.filter((p) => p.id !== proposal.id));
            try {
                const res = await acceptProposal(proposal.id);
                if (res.needsCloud) {
                    // On-device: nothing ran, the proposal stays. Say why, once.
                    void showCloudOnlyNotice();
                    void load();
                } else if (res.floorHeld) {
                    // Nothing was cleaned and nothing failed: the proposal is settled, quietly.
                } else if (res.applied && res.ok) {
                    toastManager.showSuccess(t('hygiene.appliedTitle'), t('hygiene.appliedBody'));
                } else {
                    toastManager.showError(t('hygiene.applyFailedTitle'), t('hygiene.applyFailedBody'));
                    void load(); // restore truth from storage
                }
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneSuggestionCard', method: 'accept', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, t, load],
    );

    const dismiss = useCallback(
        async (proposal: HygieneProposal) => {
            if (actingId) return;
            setActingId(proposal.id);
            void hapticLight();
            setItems((prev) => prev.filter((p) => p.id !== proposal.id));
            try {
                await rejectProposal(proposal.id);
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneSuggestionCard', method: 'reject', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, load],
    );

    return { items, actingId, accept, dismiss };
}

export const HygieneSuggestionCard: React.FC<{
    readonly item: HygieneProposal;
    readonly busy: boolean;
    readonly onAccept: (item: HygieneProposal) => void;
    readonly onDismiss: (item: HygieneProposal) => void;
}> = ({ item, busy, onAccept, onDismiss }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const duplicate = item.kind === 'duplicate_facts';
    const facts = useHubFacts();
    // A proposal saved before `subject` existed has no summary: name its facts
    // from the table instead, so Accept is never blind.
    const factNames = (facts ?? [])
        .filter((f) => item.targetFactIds.includes(f.id))
        .map((f) => sentenceCase(f.statement))
        .join('\n');
    const summary = summaryFor(item, t) ?? (factNames || null);
    return (
        <View
            testID={`hygiene-card-${item.id}`}
            style={{
                marginHorizontal: PAGE_SIDE_INSET,
                marginBottom: 12,
                padding: 16,
                gap: 8,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: colors.line,
                backgroundColor: colors.surface,
            }}
        >
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '700' }}>{titleForKind(item.kind, t)}</Text>
            {summary ? (
                <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }} numberOfLines={4}>
                    {summary}
                </Text>
            ) : null}
            <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{effectPreview(item.kind, t)}</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                <ActionButton
                    testID={`hygiene-accept-${item.id}`}
                    label={duplicate ? t('hygiene.merge') : t('hygiene.accept')}
                    onPress={() => onAccept(item)}
                    filled
                    disabled={busy}
                />
                <ActionButton
                    testID={`hygiene-reject-${item.id}`}
                    label={duplicate ? t('hygiene.keepBoth') : t('hygiene.reject')}
                    onPress={() => onDismiss(item)}
                    disabled={busy}
                />
            </View>
        </View>
    );
};
