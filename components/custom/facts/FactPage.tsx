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
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { sectionTitle } from '@/components/custom/for-you/section-title';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import MeraLogo from '@/components/custom/MeraLogo';
import { clearHeaderBottom, reportHeaderBottom } from '@/components/custom/nav/current-surface';
import { openSectionedFeed } from '@/components/custom/feed/feed-view-prefs';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Pressable } from '@/components/ui/pressable';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { StepSlider } from '@/components/ui/step-slider';
import InlineChoiceChip from '@/components/custom/nav/InlineChoiceChip';
import { Text } from '@/components/ui/text';
import { retryTopicGeneration } from '@/lib/chat-tools/tool-handlers';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { isSuggestionOpened, sectionKindOf, type FactRowGroup } from '@/lib/stores/fact-rows-selector';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, TextInput, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { filterStories, isLeftOut, type Story, type StoryFilter } from './fact-page-model';
import AddTopicModal from './AddTopicModal';
import { sentenceCase } from './sentence-case';
import { INFLUENCE_MAX, INFLUENCE_MIN, INFLUENCE_STEP, useFactPage, type TopicRow } from './useFactPage';

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

const STORY_FILTERS: readonly StoryFilter[] = ['all', 'suggested', 'discarded'];
type Item =
    | { kind: 'topic'; topic: TopicRow }
    | { kind: 'story'; story: FactRowGroup | Story; left: boolean };

const FactPage: React.FC<FactPageProps> = ({ factId, from, statement = '' }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const themeMode = useThemeMode();
    const insets = useSafeAreaInsets();
    const reduceMotion = useReducedMotion();
    const active = useIsFocusedSafe();
    const {
        tab,
        setTab,
        filter,
        setFilter,
        fact,
        topics,
        impactful,
        leftOut,
        topicStories,
        total,
        filterCount,
        filterLabel,
        nextFact,
        displayStatement,
        setMenuOpen,
        menuOpen,
        pendingMenu,
        onMenuClosed,
        influence,
        setWeight,
        confirmTopic,
        setConfirmTopic,
        dontAsk,
        setDontAsk,
        askDeleteTopic,
        confirmDeleteTopic,
        addOpen,
        setAddOpen,
        addText,
        setAddText,
        adding,
        confirmAdd,
        suggesting,
        suggestMore,
        knownIds,
        status,
        retrying,
        setRetrying,
        chips,
        phrase,
        setPhrase,
        addPhrase,
        openedIds,
        openSuggestion,
        taught,
        markRelevant,
    } = useFactPage({ factId, from, statement });

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
        return filterStories(filter, impactful, leftOut).map(({ story, left }) => ({ kind: 'story' as const, story, left }));
    }, [tab, filter, topics, impactful, leftOut]);

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
                            testID={`topic-delete-${item.topic.id}`}
                            onPress={() => void askDeleteTopic(item.topic)}
                            accessibilityRole="button"
                            accessibilityLabel={t('facts.page.deleteTopicA11y', { topic: item.topic.text })}
                            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        >
                            <MaterialIcons name="delete-outline" size={18} color={colors.ink3} />
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
        [knownIds, reduceMotion, topicStories, colors, t, openSuggestion, openedIds, taught, markRelevant, askDeleteTopic],
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
                <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
                    <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('facts.page.howMuch')}</Text>
                    <StepSlider
                        testID="fact-influence"
                        value={influence}
                        min={INFLUENCE_MIN}
                        max={INFLUENCE_MAX}
                        step={INFLUENCE_STEP}
                        onChange={(v) => void setWeight(v)}
                        formatValue={(v) => `${Math.round(v * 100)}%`}
                        lowLabel={t('locations.weight.low')}
                        highLabel={t('locations.weight.high')}
                        accessibilityLabel={t('facts.page.howMuch')}
                    />
                </View>
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
                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                        <InlineChoiceChip<StoryFilter>
                            testID="fact-filter"
                            options={STORY_FILTERS}
                            value={filter}
                            labelOf={(f) => `${filterLabel(f)} ${filterCount(f)}`}
                            a11yLabelOf={(f) => t('facts.page.filterA11y', { filter: filterLabel(f) })}
                            onChange={setFilter}
                        />
                    </View>
                    <Help>
                        {filter === 'all'
                            ? t('facts.page.allHint')
                            : filter === 'suggested'
                              ? t('facts.page.impactfulHint')
                              : t('facts.page.discardedHint')}
                    </Help>
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
                        <MeraLogo size={26} animated />
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
                keyboardAppearance={themeMode}
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
        tab === 'recent' && filterCount(filter) === 0 ? (
            <View style={{ paddingHorizontal: 18, paddingTop: 24 }} testID={`fact-${filter}-empty`}>
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>
                    {filter === 'discarded' ? t('facts.page.discardedEmpty') : t('facts.page.impactfulEmpty')}
                </Text>
            </View>
        ) : null;

    const nextFooter = nextFact ? (
        <View style={{ paddingHorizontal: 14, paddingTop: 16 }}>
            <Group>
                <Row
                    testID="fact-next-interest"
                    title={sectionTitle(t, nextFact)}
                    // A headline section's title is app copy, already in the app
                    // language; only a fact statement is data for the translator.
                    translatable={sectionKindOf(nextFact) === 'fact'}
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
                contentContainerStyle={{ paddingTop: SUBPAGE_TOP_GAP, paddingBottom: insets.bottom + 120 }}
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

            <ConfirmDialog
                testID="fact-topic-delete"
                open={confirmTopic !== null}
                title={t('facts.page.deleteTopicTitle')}
                body={t('facts.page.deleteTopicBody')}
                confirmLabel={t('common.delete')}
                destructive
                onConfirm={confirmDeleteTopic}
                onCancel={() => setConfirmTopic(null)}
                checkbox={{ label: t('common.dontAskAgain'), value: dontAsk, onChange: setDontAsk }}
            />

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
