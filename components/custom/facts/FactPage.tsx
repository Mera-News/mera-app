// The ONE page for a fact (FinalProfile #6-#10, FinalFeed #6/#7), opened from
// Profile > Facts (You stack, starts on Topics) and from the Feed's sectioned
// headers (Feed stack, starts on Recent articles, Next interest at the end).
//
// Counts are STORIES everywhere (owner Y1). Impactful is this fact's section
// from the Feed's own `buildFactRows`, so it matches the sectioned header;
// Not impactful and the per-topic counts come from `fact-page-model`.
// Turning a topic down happens only here: its ••• or the Show less of field.
import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import { StatusIndicator } from '@/components/custom/chat/StatusIndicator';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { useSessionGeoLanguageContext } from '@/components/custom/feed/use-session-geo-context';
import { sectionTitle } from '@/components/custom/for-you/section-title';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { useSectionSnapshots } from '@/components/custom/for-you/use-section-snapshots';
import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import MeraLogo from '@/components/custom/MeraLogo';
import { clearHeaderBottom, reportHeaderBottom } from '@/components/custom/nav/current-surface';
import { openSectionedFeed } from '@/components/custom/feed/feed-view-prefs';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { recordVerdictFeedback } from '@/lib/database/services/article-feedback-service';
import { deleteFact, observeFact } from '@/lib/database/services/fact-service';
import { nudgeFactWeight } from '@/lib/database/services/mutation-rails-service';
import { addSuppression, getActive as getActiveSuppressions, retireSuppression } from '@/lib/database/services/suppression-service';
import { deleteTopicWithDecline, listDeclinedTopics, recordDecline, removeDecline } from '@/lib/database/services/topic-decline-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { createTopics, normalizeTopicText, observeByFact, reactivate, retire } from '@/lib/database/services/topic-service';
import { showDialog } from '@/lib/dialog';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { buildFactRows, isSuggestionOpened, type FactRowGroup } from '@/lib/stores/fact-rows-selector';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, TextInput, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isLeftOut, leftOutStories, storiesPerTopic, type Story } from './fact-page-model';
import AddTopicModal from './AddTopicModal';
import { sentenceCase } from './sentence-case';

export interface FactPageProps {
    readonly factId: string;
    /** Which stack opened it: the Feed shows the Next interest footer and
     *  starts on Recent articles; You starts on Topics. */
    readonly from: 'feed' | 'you';
    /** Title shown before the facts load (no flash). */
    readonly statement?: string;
    /** Arrived through the previous fact's Next footer (Feed only). */
    readonly arrivedFromNext?: boolean;
}

/** How much a fact counts: 10% to 100% in 10% steps (`nudgeFactWeight`). */
const INFLUENCE_STEP = 0.1;
const INFLUENCE_MIN = 0.1;
const INFLUENCE_MAX = 1.0;
const round1 = (n: number) => Math.round(n * 10) / 10;
const GENERATE_MORE_TOPIC_COUNT = 10;
/** A typed Show less of phrase: a soft filter that never expires (owner Y4). */
const SOFT_STRENGTH = 0.5;

type Tab = 'topics' | 'recent';
type Side = 'impactful' | 'left';
interface TopicRow {
    readonly id: string;
    readonly text: string;
}
interface Chip {
    readonly key: string;
    readonly text: string;
    readonly remove: () => Promise<void>;
}
type Item =
    | { kind: 'topic'; topic: TopicRow }
    | { kind: 'story'; story: FactRowGroup | Story; left: boolean };

const FactPage: React.FC<FactPageProps> = ({ factId, from, statement = '' }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const insets = useSafeAreaInsets();
    const reduceMotion = useReducedMotion();
    const active = useIsFocusedSafe();

    const [tab, setTab] = useState<Tab>(from === 'feed' ? 'recent' : 'topics');
    const [side, setSide] = useState<Side>('impactful');

    // ── The fact and its topics ────────────────────────────────────────────
    const [fact, setFact] = useState<Fact | null>(null);
    useEffect(() => {
        const sub = observeFact(factId).subscribe(setFact);
        return () => sub.unsubscribe();
    }, [factId]);

    const [topics, setTopics] = useState<TopicRow[]>([]);
    const [turnedDown, setTurnedDown] = useState<{ id: string; text: string; negative: boolean }[]>([]);
    useEffect(() => {
        const sub = observeByFact(factId).subscribe((rows) => {
            setTopics(rows.filter((r) => r.status === 'active' && r.weight >= 0).map((r) => ({ id: r.id, text: r.text })));
            setTurnedDown(
                rows
                    .filter((r) => r.status === 'suppressed' || (r.status === 'active' && r.weight < 0))
                    .map((r) => ({ id: r.id, text: r.text, negative: r.weight < 0 })),
            );
        });
        return () => sub.unsubscribe();
    }, [factId]);

    const [declines, setDeclines] = useState<{ id: string; text: string }[]>([]);
    useEffect(() => {
        const sub = listDeclinedTopics().subscribe((rows) =>
            setDeclines(rows.filter((r) => r.sourceFactId === factId).map((r) => ({ id: r.id, text: r.text }))),
        );
        return () => sub.unsubscribe();
    }, [factId]);

    // ── Stories ────────────────────────────────────────────────────────────
    const suggestions = useForYouSuggestions();
    const openedIds = useOpenedStoriesStore((s) => s.ids);
    useEffect(() => {
        void useOpenedStoriesStore.getState().hydrate();
    }, []);
    const snapshots = useSectionSnapshots('FactPage');
    const geoCtx = useSessionGeoLanguageContext(useUserGeoLanguageContext(), factId);
    // ONE buildFactRows pass (the expensive selector), for Impactful and for
    // the Next interest footer.
    const rows = useMemo(
        () => (snapshots ? buildFactRows(suggestions, snapshots, openedIds, Date.now(), DEFAULT_HARNESS_CONFIG, geoCtx).rows : []),
        [snapshots, suggestions, openedIds, geoCtx],
    );
    const impactful = useMemo(() => {
        const groups = rows.find((r) => r.factId === factId)?.groups ?? [];
        return [...groups].sort((a, b) => b.pubDateMs - a.pubDateMs);
    }, [rows, factId]);
    const leftOut = useMemo(() => leftOutStories(suggestions, factId, Date.now()), [suggestions, factId]);
    const topicStories = useMemo(() => storiesPerTopic([...impactful, ...leftOut]), [impactful, leftOut]);
    const total = impactful.length + leftOut.length;

    const nextFact = useMemo(() => {
        if (from !== 'feed') return null;
        const idx = rows.findIndex((r) => r.factId === factId);
        return idx === -1 ? null : rows.slice(idx + 1).find((r) => r.groups.length > 0) ?? null;
    }, [from, rows, factId]);

    // Section visits: the sectioned Feed's "new since you looked" reads them.
    useEffect(() => {
        if (from !== 'feed') return undefined;
        void useSectionVisitsStore.getState().hydrate().then(() => useSectionVisitsStore.getState().markVisited(factId));
        return () => useSectionVisitsStore.getState().markVisited(factId);
    }, [from, factId]);

    // ── Header: menu, title block, influence ───────────────────────────────
    const displayStatement = sentenceCase(fact?.statement ?? statement);
    const [menuOpen, setMenuOpen] = useState(false);
    const pendingMenu = useRef<'edit' | 'delete' | null>(null);
    const onMenuClosed = useCallback(async () => {
        const choice = pendingMenu.current;
        pendingMenu.current = null;
        if (!choice || !fact) return;
        if (choice === 'edit') {
            openMeraChat({ kind: 'persona' }, { draft: t('meraDraft.changeInterest', { statement: displayStatement }) });
            return;
        }
        const ok = await showDialog({
            title: t('configPanel.deleteFactTitle'),
            body: `${t('configPanel.deleteFactConfirm')}\n\n${displayStatement}`,
            warning: t('configPanel.deleteFactWarning'),
            confirmLabel: t('configPanel.yesDelete'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!ok) return;
        try {
            await deleteFact(fact.id);
            toastManager.showSuccess(t('configPanel.factDeletedTitle'), t('configPanel.factDeletedDescription'));
            if (router.canGoBack()) router.back();
        } catch (error) {
            logger.error('[FactPage] deleteFact failed', error, { factId: fact.id });
            toastManager.showError(t('configPanel.deleteFailedTitle'), t('configPanel.deleteFailedDescription'));
        }
    }, [fact, displayStatement, t]);

    // Optimistic mirror of the stored weight (null reads as 100%).
    const [influence, setInfluence] = useState(1);
    useEffect(() => {
        setInfluence(round1(fact?.weight ?? 1));
    }, [fact?.id, fact?.weight]);
    const nudge = useCallback(
        async (direction: 1 | -1) => {
            if (!fact) return;
            const next = round1(Math.max(INFLUENCE_MIN, Math.min(INFLUENCE_MAX, influence + INFLUENCE_STEP * direction)));
            if (next === influence) return;
            const prev = influence;
            setInfluence(next);
            void hapticLight();
            try {
                await nudgeFactWeight(fact.id, INFLUENCE_STEP * direction, 'user');
            } catch (err) {
                setInfluence(prev);
                logger.warn('[FactPage] influence nudge failed', { factId: fact.id, error: String(err) });
            }
        },
        [fact, influence],
    );

    // ── Topics: turn down, add, suggest more, retry ────────────────────────
    const [topicMenu, setTopicMenu] = useState<TopicRow | null>(null);
    const pendingTurnDown = useRef<TopicRow | null>(null);
    const onTopicMenuClosed = useCallback(() => {
        const topic = pendingTurnDown.current;
        pendingTurnDown.current = null;
        if (!topic) return;
        // A permanent decline (with the 5 s undo): the persona agent never
        // proposes it again until it is lifted from the chip field below.
        deleteTopicWithDecline(topic.id).catch((error) =>
            logger.error('[FactPage] turn down failed', error, { factId, topicId: topic.id }),
        );
    }, [factId]);

    const [addOpen, setAddOpen] = useState(false);
    const [addText, setAddText] = useState('');
    const [adding, setAdding] = useState(false);
    const confirmAdd = useCallback(async () => {
        const text = addText.trim();
        if (!text) return;
        setAdding(true);
        try {
            // WEIGHT IS LOAD-BEARING: a topic at 0 is never queried.
            await createTopics([{ factId, text, weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight }]);
            setAddOpen(false);
            setAddText('');
        } catch (error) {
            logger.error('[FactPage] addTopic failed', error, { factId });
        } finally {
            setAdding(false);
        }
    }, [addText, factId]);

    // Suggest more starts at once. Rows that were not there at the tap are New.
    const [suggesting, setSuggesting] = useState(false);
    const [knownIds, setKnownIds] = useState<Set<string> | null>(null);
    const suggestMore = useCallback(async () => {
        if (!fact || suggesting) return;
        setKnownIds(new Set(topics.map((x) => x.id)));
        setSuggesting(true);
        const done = () => setSuggesting(false);
        try {
            const out = await generateMoreTopicsForFact(fact.id, fact.statement, { count: GENERATE_MORE_TOPIC_COUNT });
            if (out.mode === 'queued') {
                inferenceQueue.onDrain(done);
                return;
            }
            if (out.mode === 'skipped' || out.added === 0) {
                toastManager.showError(t('configPanel.generateMoreTopicsFailedTitle'), t('configPanel.generateMoreTopicsFailedDescription'));
            }
        } catch (error) {
            logger.error('[FactPage] generateMoreTopics failed', error, { factId: fact.id });
            toastManager.showError(t('configPanel.generateMoreTopicsFailedTitle'), t('configPanel.generateMoreTopicsFailedDescription'));
        }
        done();
    }, [fact, suggesting, topics, t]);

    // topics_status: null renders like done; retry is an enqueue, so its busy
    // state follows the status leaving 'error', never the call settling.
    const status = fact?.topicsStatus ?? 'done';
    const [retrying, setRetrying] = useState(false);
    useEffect(() => {
        if (status !== 'error') setRetrying(false);
    }, [status]);

    // ── Show less of ───────────────────────────────────────────────────────
    const chips: Chip[] = useMemo(() => {
        const seen = new Set<string>();
        const out: Chip[] = [];
        for (const d of declines) {
            const key = normalizeTopicText(d.text);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                key: `d:${d.id}`,
                text: d.text,
                remove: async () => {
                    await removeDecline(d.id);
                    // A phrase typed here also wrote a filter: lift that. A
                    // topic turned down from its ••• wrote none: bring it back.
                    const filters = (await getActiveSuppressions()).filter((s) => normalizeTopicText(s.pattern) === key);
                    if (filters.length > 0) {
                        await Promise.all(filters.map((s) => retireSuppression(s.id)));
                    } else {
                        await createTopics([{ factId, text: d.text, weight: DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight }]);
                    }
                },
            });
        }
        for (const topic of turnedDown) {
            const key = normalizeTopicText(topic.text);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                key: `t:${topic.id}`,
                text: topic.text,
                // A negative topic pulls stories down: retire it. A suppressed
                // one was a real interest: make it active again.
                remove: () => (topic.negative ? retire(topic.id) : reactivate(topic.id)),
            });
        }
        return out;
    }, [declines, turnedDown, factId]);

    const [phrase, setPhrase] = useState('');
    const addPhrase = useCallback(async () => {
        const text = phrase.trim();
        if (!text) return;
        setPhrase('');
        try {
            await recordDecline(text, factId);
            await addSuppression({ pattern: text, keywords: [text], strength: SOFT_STRENGTH, source: 'user', expiresAt: null });
        } catch (error) {
            logger.error('[FactPage] add phrase failed', error, { factId });
        }
    }, [phrase, factId]);

    // ── Opening articles, "This was relevant" ──────────────────────────────
    const openSuggestion = useOpenSuggestion('sectioned');
    const [taught, setTaught] = useState<Set<string>>(new Set());
    const markRelevant = useCallback((story: Story) => {
        const s = story.data;
        setTaught((prev) => new Set(prev).add(s._id));
        void hapticSuccess();
        void recordVerdictFeedback({
            articleId: s.articleId,
            suggestionId: s._id,
            sentiment: 'like',
            title: s.title_en ?? s.title_original ?? '',
            surface: 'sectioned',
        });
    }, []);

    // ── Header bottom for the Mera button's top corners ────────────────────
    const [headerBottom, setHeaderBottom] = useState(0);
    const headerOwner = `fact:${factId}`;
    useEffect(() => {
        if (active && headerBottom > 0) reportHeaderBottom(headerOwner, headerBottom);
        return active ? () => clearHeaderBottom(headerOwner) : undefined;
    }, [active, headerBottom, headerOwner]);

    // ── List ───────────────────────────────────────────────────────────────
    const data: Item[] = useMemo(() => {
        if (tab === 'topics') return topics.map((topic) => ({ kind: 'topic' as const, topic }));
        const stories: (FactRowGroup | Story)[] = side === 'impactful' ? impactful : leftOut;
        return stories.map((story) => ({ kind: 'story' as const, story, left: side === 'left' }));
    }, [tab, side, topics, impactful, leftOut]);

    const renderItem = useCallback(
        ({ item }: { item: Item }) => {
            if (item.kind === 'topic') {
                const isNew = knownIds !== null && !knownIds.has(item.topic.id);
                const row = (
                    <View style={{ marginHorizontal: 14, flexDirection: 'row', alignItems: 'center' }}>
                        <View style={{ flex: 1 }}>
                            <Row
                                testID={`fact-topic-${item.topic.id}`}
                                title={sentenceCase(item.topic.text)}
                                translatable
                                subtitle={t('facts.page.storyCount', { count: topicStories(item.topic) })}
                                trailing={isNew ? <NewPill label={t('facts.page.new')} /> : null}
                                onPress={() =>
                                    router.push({
                                        pathname: '/logged-in/persona-articles',
                                        params: { topicTexts: JSON.stringify([item.topic.text]) },
                                    })
                                }
                                hideChevron
                            />
                        </View>
                        <Pressable
                            testID={`fact-topic-menu-${item.topic.id}`}
                            onPress={() => setTopicMenu(item.topic)}
                            accessibilityRole="button"
                            accessibilityLabel={t('facts.page.topicMenuA11y', { text: item.topic.text })}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <MaterialIcons name="more-horiz" size={22} color={colors.ink2} />
                        </Pressable>
                    </View>
                );
                return isNew && !reduceMotion ? <Animated.View entering={FadeInDown.duration(260)}>{row}</Animated.View> : row;
            }
            const s = item.story.data;
            return (
                <View style={{ marginHorizontal: 8 }}>
                    <ArticleSuggestionCompactCard
                        suggestion={s}
                        onPress={openSuggestion}
                        surface="sectioned"
                        read={isSuggestionOpened(s, openedIds)}
                    />
                    {item.left && isLeftOut(s) ? (
                        <Pressable
                            testID={`fact-relevant-${s._id}`}
                            onPress={() => markRelevant(item.story as Story)}
                            disabled={taught.has(s._id)}
                            accessibilityRole="button"
                            accessibilityState={{ disabled: taught.has(s._id) }}
                            style={{
                                alignSelf: 'flex-start',
                                marginLeft: 12,
                                marginBottom: 10,
                                minHeight: 44,
                                justifyContent: 'center',
                                opacity: taught.has(s._id) ? 0.5 : 1,
                            }}
                        >
                            <View style={{ borderRadius: 999, borderWidth: 1, borderColor: colors.trackBorder, paddingHorizontal: 14, paddingVertical: 7 }}>
                                <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{t('facts.page.thisWasRelevant')}</Text>
                            </View>
                        </Pressable>
                    ) : null}
                </View>
            );
        },
        [knownIds, reduceMotion, topicStories, colors, t, openSuggestion, openedIds, taught, markRelevant],
    );

    const header = (
        <View style={{ paddingHorizontal: 14, gap: 10, paddingBottom: 10 }}>
            <View style={{ gap: 4 }}>
                <Text style={{ color: colors.ink, fontSize: 20, lineHeight: 26, fontWeight: '700' }} accessibilityRole="header">
                    {displayStatement}
                </Text>
                <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18 }}>{t('facts.page.reach', { count: total })}</Text>
            </View>
            <Group>
                <Row
                    title={t('facts.page.howMuch')}
                    trailing={<Stepper value={influence} onStep={nudge} />}
                />
            </Group>
            <SegmentedControl
                testID="fact-tabs"
                accessibilityLabel={t('facts.page.title')}
                value={tab}
                onChange={setTab}
                options={[
                    { value: 'topics', label: `${t('facts.page.topicsTab')} ${topics.length}` },
                    { value: 'recent', label: `${t('facts.page.recentTab')} ${total}` },
                ]}
                style={{ alignSelf: 'center' }}
            />
            {tab === 'topics' && status === 'error' ? (
                <Pressable
                    testID="fact-topics-retry"
                    onPress={() => {
                        if (retrying || !fact) return;
                        setRetrying(true);
                        void retryTopicGeneration(fact.id, fact.statement);
                    }}
                    disabled={retrying}
                    accessibilityRole="button"
                    accessibilityLabel={t('configPanel.retryTopicGeneration')}
                    style={{ minHeight: 44, justifyContent: 'center' }}
                >
                    <StatusIndicator status="error" label={t('configPanel.retryTopicGeneration')} />
                </Pressable>
            ) : null}
            {tab === 'recent' ? (
                <>
                    <SegmentedControl
                        testID="fact-sides"
                        accessibilityLabel={t('facts.page.recentTab')}
                        value={side}
                        onChange={setSide}
                        options={[
                            { value: 'impactful', label: `${t('facts.page.impactful')} ${impactful.length}` },
                            { value: 'left', label: `${t('facts.page.notImpactful')} ${leftOut.length}` },
                        ]}
                        style={{ alignSelf: 'center' }}
                    />
                    <Help>{side === 'impactful' ? t('facts.page.impactfulHint') : t('facts.page.notImpactfulHint')}</Help>
                </>
            ) : null}
        </View>
    );

    const topicsFooter = (
        <View style={{ paddingHorizontal: 14, paddingTop: 10, gap: 12 }}>
            {suggesting || status === 'pending' ? (
                <Row testID="fact-topics-looking" title={t('facts.page.stillLooking')} titleColor={colors.ink2} />
            ) : null}
            <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pill testID="fact-add-topic" label={t('configPanel.addTopic')} icon="add" onPress={() => setAddOpen(true)} />
                {suggesting ? (
                    <View
                        testID="fact-suggesting"
                        accessible
                        accessibilityLabel={t('chatTopics.finding')}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 8 }}
                    >
                        <MeraLogo size={26} animated showsProgress />
                        <Text style={{ color: colors.ink2, fontSize: 14 }}>{t('chatTopics.finding')}</Text>
                    </View>
                ) : (
                    <Pill testID="fact-suggest-more" label={t('facts.page.suggestMore')} icon="auto-awesome" filled onPress={suggestMore} />
                )}
            </View>
            <GroupLabel>{t('facts.page.showLessOf')}</GroupLabel>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {chips.map((chip) => (
                    <View
                        key={chip.key}
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            height: 40,
                            paddingLeft: 14,
                            borderRadius: 999,
                            backgroundColor: colors.surfaceRaised,
                            borderWidth: 1,
                            borderColor: colors.trackBorder,
                        }}
                    >
                        <Text style={{ color: colors.ink, fontSize: 15 }}>{sentenceCase(chip.text)}</Text>
                        <Pressable
                            onPress={() => {
                                chip.remove().catch((error) => logger.error('[FactPage] remove chip failed', error, { factId }));
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('facts.page.removeChipA11y', { text: chip.text })}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <MaterialIcons name="close" size={16} color={colors.ink2} />
                        </Pressable>
                    </View>
                ))}
            </View>
            <TextInput
                testID="fact-show-less-input"
                value={phrase}
                onChangeText={setPhrase}
                onSubmitEditing={addPhrase}
                placeholder={t('facts.page.showLessPlaceholder')}
                placeholderTextColor={colors.ink3}
                returnKeyType="done"
                accessibilityLabel={t('facts.page.showLessPlaceholder')}
                style={{
                    minHeight: 44,
                    borderRadius: 12,
                    paddingHorizontal: 14,
                    color: colors.ink,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.line,
                    fontSize: 15,
                }}
            />
            <Help>{t('facts.page.showLessHint')}</Help>
        </View>
    );

    const recentFooter =
        tab === 'recent' && side === 'left' && leftOut.length === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 24, gap: 6 }} testID="fact-left-empty">
                <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('facts.page.emptyTitle')}</Text>
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('facts.page.emptyBody')}</Text>
            </View>
        ) : tab === 'recent' && side === 'impactful' && impactful.length === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 24 }} testID="fact-impactful-empty">
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('facts.page.impactfulEmpty')}</Text>
            </View>
        ) : null;

    const nextFooter = nextFact ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 16 }}>
            <Group>
                <Row
                    testID="fact-next-interest"
                    title={sectionTitle(t, nextFact)}
                    translatable
                    subtitle={t('facts.page.nextInterest')}
                    onPress={() =>
                        router.replace({
                            pathname: '/logged-in/app_container/feed/interest',
                            params: { factId: nextFact.factId, statement: sectionTitle(t, nextFact), via: 'next' },
                        })
                    }
                />
            </Group>
        </View>
    ) : from === 'feed' ? (
        // The last interest: the way back is the sectioned Feed.
        <View style={{ paddingHorizontal: 14, paddingTop: 16 }}>
            <Group>
                <Row testID="fact-back-to-feed" title={t('trackedStories.emptyCta')} onPress={openSectionedFeed} />
            </Group>
        </View>
    ) : null;

    return (
        <View style={{ flex: 1 }}>
            <AbstractGradientBackdrop seed={factId} />
            <View
                style={{ paddingTop: insets.top }}
                onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
            >
                <DrillDownHeader
                    title={t('facts.page.title')}
                    onBack={() => (from === 'feed' && !router.canGoBack() ? openSectionedFeed() : router.back())}
                    rightAction={
                        <Pressable
                            testID="fact-menu"
                            onPress={() => setMenuOpen(true)}
                            accessibilityRole="button"
                            accessibilityLabel={t('facts.page.menuA11y')}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <MaterialIcons name="more-horiz" size={24} color={colors.ink} />
                        </Pressable>
                    }
                />
            </View>
            <FlatList
                testID="fact-page-list"
                data={data}
                keyExtractor={(item) => (item.kind === 'topic' ? item.topic.id : item.story.data._id)}
                renderItem={renderItem}
                ListHeaderComponent={header}
                ListEmptyComponent={
                    tab === 'topics' && !suggesting && status !== 'pending' ? (
                        // The tutorial hero over an empty topic list (FinalMotion, Lottie moments).
                        <ForYouEmptyState testID="fact-topics-empty" compact animationId="facts-a-fact-is" body="" />
                    ) : null
                }
                ListFooterComponent={
                    <>
                        {tab === 'topics' ? topicsFooter : recentFooter}
                        {nextFooter}
                    </>
                }
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
                onContentSizeChange={() => {
                    if (active) notifyScrollTick();
                }}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={10}
                contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 120 }}
                showsVerticalScrollIndicator={false}
            />

            <BottomSheet
                testID="fact-menu-sheet"
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                onClosed={onMenuClosed}
            >
                <Group>
                    <Row
                        testID="fact-menu-edit"
                        title={t('facts.page.edit')}
                        leadingIcon="edit"
                        onPress={() => {
                            pendingMenu.current = 'edit';
                            setMenuOpen(false);
                        }}
                        hideChevron
                    />
                    <Row
                        testID="fact-menu-delete"
                        title={t('common.delete')}
                        leadingIcon="delete-outline"
                        titleColor={colors.negative}
                        onPress={() => {
                            pendingMenu.current = 'delete';
                            setMenuOpen(false);
                        }}
                        hideChevron
                    />
                </Group>
            </BottomSheet>

            <BottomSheet
                testID="fact-topic-sheet"
                open={topicMenu !== null}
                onClose={() => setTopicMenu(null)}
                onClosed={onTopicMenuClosed}
            >
                <Group>
                    <Row
                        testID="fact-topic-show-less"
                        title={t('facts.page.showLessThis')}
                        leadingIcon="visibility-off"
                        onPress={() => {
                            pendingTurnDown.current = topicMenu;
                            setTopicMenu(null);
                        }}
                        hideChevron
                    />
                </Group>
            </BottomSheet>

            <AddTopicModal
                isOpen={addOpen}
                value={addText}
                isAdding={adding}
                onChangeText={setAddText}
                onConfirm={confirmAdd}
                onCancel={() => {
                    setAddOpen(false);
                    setAddText('');
                }}
            />
        </View>
    );
};

/** − 100% + */
const Stepper: React.FC<{ readonly value: number; readonly onStep: (direction: 1 | -1) => void }> = ({ value, onStep }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const button = (direction: 1 | -1, disabled: boolean) => (
        <Pressable
            testID={direction > 0 ? 'fact-influence-more' : 'fact-influence-less'}
            onPress={() => onStep(direction)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={direction > 0 ? t('facts.moreInfluence') : t('facts.lessInfluence')}
            accessibilityState={{ disabled }}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : 1 }}
        >
            <MaterialIcons name={direction > 0 ? 'add' : 'remove'} size={20} color={colors.ink} />
        </Pressable>
    );
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: -8 }}>
            {button(-1, value <= INFLUENCE_MIN + 1e-6)}
            <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600', minWidth: 44, textAlign: 'center' }}>
                {Math.round(value * 100)}%
            </Text>
            {button(1, value >= INFLUENCE_MAX - 1e-6)}
        </View>
    );
};

const NewPill: React.FC<{ readonly label: string }> = ({ label }) => {
    const colors = useColors();
    return (
        <View style={{ borderRadius: 999, backgroundColor: colors.accent, paddingHorizontal: 8, height: 22, justifyContent: 'center' }}>
            <Text scaleTier="chrome" style={{ color: colors.onAccent, fontSize: 12, fontWeight: '700' }}>
                {label}
            </Text>
        </View>
    );
};

/** Add a topic (outlined) and Suggest more (filled). */
const Pill: React.FC<{
    readonly label: string;
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly filled?: boolean;
    readonly onPress: () => void;
    readonly testID: string;
}> = ({ label, icon, filled = false, onPress, testID }) => {
    const colors = useColors();
    const ink = filled ? colors.onAccent : colors.ink;
    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: 44,
                paddingHorizontal: 18,
                borderRadius: 999,
                backgroundColor: filled ? colors.accent : 'transparent',
                borderWidth: filled ? 0 : 1,
                borderColor: colors.trackBorder,
            }}
        >
            <MaterialIcons name={icon} size={18} color={ink} />
            <Text style={{ color: ink, fontSize: 15, fontWeight: '600' }}>{label}</Text>
        </Pressable>
    );
};

export default FactPage;
