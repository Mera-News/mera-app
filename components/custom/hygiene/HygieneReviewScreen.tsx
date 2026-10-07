import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { sentenceCase } from '@/components/custom/facts/sentence-case';
import { Group, Row } from '@/components/custom/you/rows';
import { useActiveTopicTexts, useHubFacts } from '@/components/custom/you/use-hub-data';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { showDialog } from '@/lib/dialog';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { useColors } from '@/lib/theme/tokens';
import {
    acceptProposal,
    getPendingProposals,
    rejectProposal,
    subscribeHygieneChange,
} from '@/lib/database/services/hygiene-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';
import type {
    HygieneProposal,
    HygieneProposalKind,
} from '@/lib/news-harness/persona-management/fact-hygiene';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FlatList, View } from 'react-native';
import { notifyScrollTick } from '@/lib/visibility-tick';


interface HygieneReviewScreenProps {
    readonly onBack: () => void;
}

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
            return t('hygiene.effectTooBroad', {
                defaultValue: 'Lowers this interest’s weight so it pulls in fewer off-topic stories.',
            });
        case 'stale_topic':
            return t('hygiene.effectStaleTopic', {
                defaultValue: 'Retires this quiet topic.',
            });
        case 'stale_fact':
            return t('hygiene.effectStaleFact', {
                defaultValue: 'Removes this fact. None of its topics are active anymore.',
            });
        case 'incoherent_topics':
            return t('hygiene.effectIncoherentTopics', {
                defaultValue: 'Replaces these topics with better ones for this interest.',
            });
        case 'location_conflict':
            return t('hygiene.effectLocationConflict');
        default:
            return '';
    }
}

/** The facts a suggestion is about, as rows with their topic counts. */
const FactLine: React.FC<{ readonly fact: Fact }> = ({ fact }) => {
    const { t } = useTranslation();
    const count = useActiveTopicTexts(fact.id).length;
    return <Row title={sentenceCase(fact.statement)} translatable value={t('you.profile.topicCount', { count })} />;
};

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
            style={{
                flex: 1,
                height: 44,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: filled ? colors.accent : 'transparent',
                borderWidth: filled ? 0 : 1,
                borderColor: colors.trackBorder,
                opacity: disabled ? 0.5 : 1,
            }}
        >
            <Text style={{ color: filled ? colors.onAccent : colors.ink, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        </Pressable>
    );
};

/** The fact a suggestion would delete goes last ("removes the second fact"). */
function orderedFacts(item: HygieneProposal, byId: Map<string, Fact>): Fact[] {
    const deleted = new Set(item.ops.flatMap((op) => (op.type === 'delete_fact' ? [op.factId] : [])));
    return item.targetFactIds
        .map((id) => byId.get(id))
        .filter((f): f is Fact => f !== undefined)
        .sort((a, b) => Number(deleted.has(a.id)) - Number(deleted.has(b.id)));
}

/**
 * Tidy up your profile (FinalProfile #14, #15). Each suggestion says what it
 * is and what it would do; nothing changes until the reader chooses. A
 * duplicate offers Merge (behind a confirm: it deletes the second fact for
 * good) or Keep both.
 */
const HygieneReviewScreen: React.FC<HygieneReviewScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [items, setItems] = useState<HygieneProposal[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [actingId, setActingId] = useState<string | null>(null);
    const facts = useHubFacts();
    const factsById = useMemo(() => new Map((facts ?? []).map((f) => [f.id, f])), [facts]);

    const load = useCallback(async () => {
        try {
            setItems(await getPendingProposals());
        } catch (error) {
            logger.captureException(error, { tags: { component: 'HygieneReviewScreen', method: 'load' } });
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
        return subscribeHygieneChange(() => void load());
    }, [load]);

    const handleAccept = useCallback(
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
                if (res.applied && res.ok) {
                    toastManager.showSuccess(t('hygiene.appliedTitle'), t('hygiene.appliedBody'));
                } else {
                    toastManager.showError(t('hygiene.applyFailedTitle'), t('hygiene.applyFailedBody'));
                    void load(); // restore truth from storage
                }
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneReviewScreen', method: 'accept', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, t, load],
    );

    const handleReject = useCallback(
        async (proposal: HygieneProposal) => {
            if (actingId) return;
            setActingId(proposal.id);
            void hapticLight();
            setItems((prev) => prev.filter((p) => p.id !== proposal.id));
            try {
                await rejectProposal(proposal.id);
            } catch (error) {
                logger.captureException(error, {
                    tags: { component: 'HygieneReviewScreen', method: 'reject', kind: proposal.kind },
                });
                void load();
            } finally {
                setActingId(null);
            }
        },
        [actingId, load],
    );

    const renderItem = useCallback(
        ({ item }: { item: HygieneProposal }) => {
            const inFlight = actingId === item.id;
            const duplicate = item.kind === 'duplicate_facts';
            const factRows = orderedFacts(item, factsById);
            return (
                <View testID={`hygiene-card-${item.id}`} style={{ marginHorizontal: 14, marginBottom: 12, gap: 10 }}>
                    <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '700', marginHorizontal: 4 }}>
                        {titleForKind(item.kind, t)}
                    </Text>
                    {factRows.length > 0 ? (
                        <Group>
                            {factRows.map((fact) => (
                                <FactLine key={fact.id} fact={fact} />
                            ))}
                        </Group>
                    ) : (
                        // Topic kinds name their topics in the summary (fact-hygiene.ts).
                        <TranslatableDynamic text={item.summary} size="md" style={{ color: colors.ink, marginHorizontal: 4 }} numberOfLines={4} />
                    )}
                    <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20, marginHorizontal: 4 }}>
                        {effectPreview(item.kind, t)}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                        <ActionButton
                            testID={`hygiene-accept-${item.id}`}
                            label={duplicate ? t('hygiene.merge') : t('hygiene.accept')}
                            onPress={() => handleAccept(item)}
                            filled
                            disabled={inFlight}
                        />
                        <ActionButton
                            testID={`hygiene-reject-${item.id}`}
                            label={duplicate ? t('hygiene.keepBoth') : t('hygiene.reject')}
                            onPress={() => handleReject(item)}
                            disabled={inFlight}
                        />
                    </View>
                </View>
            );
        },
        [actingId, factsById, colors, handleAccept, handleReject, t],
    );

    return (
        <View style={{ flex: 1 }}>
            <DrillDownHeader title={t('hygiene.title')} onBack={onBack} />
            {isLoading ? (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Spinner size="large" />
                </View>
            ) : items.length === 0 ? (
                <View testID="hygiene-empty" style={{ paddingHorizontal: 18, paddingTop: 16, gap: 6 }}>
                    <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('hygiene.emptyTitle')}</Text>
                    <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('hygiene.emptyBody')}</Text>
                </View>
            ) : (
                <FlatList
                    // Rows below the first screen ask for their translation only
                    // when a scroll tick finds them on screen (lib/visibility-tick).
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    onContentSizeChange={notifyScrollTick}
                    data={items}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingTop: 4, paddingBottom: 120 }}
                    showsVerticalScrollIndicator={false}
                    ListHeaderComponent={
                        <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginHorizontal: 18, marginBottom: 12 }}>
                            {t('hygiene.intro')}
                        </Text>
                    }
                />
            )}
        </View>
    );
};

export default HygieneReviewScreen;
