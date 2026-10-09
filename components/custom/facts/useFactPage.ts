import { openMeraChat } from '@/components/custom/mera-button/open-mera-chat';
import { useSessionGeoLanguageContext } from '@/components/custom/feed/use-session-geo-context';
import { useSectionSnapshots } from '@/components/custom/for-you/use-section-snapshots';
import { recordVerdictFeedback } from '@/lib/database/services/article-feedback-service';
import { deleteFact, observeFact } from '@/lib/database/services/fact-service';
import { nudgeFactWeight } from '@/lib/database/services/mutation-rails-service';
import { addSuppression, getActive as getActiveSuppressions, retireSuppression } from '@/lib/database/services/suppression-service';
import { deleteTopicWithDecline, listDeclinedTopics, recordDecline, removeDecline } from '@/lib/database/services/topic-decline-service';
import { generateMoreTopicsForFact } from '@/lib/database/services/topic-planning-service';
import { createTopics, normalizeTopicText, observeByFact, reactivate, retire } from '@/lib/database/services/topic-service';
import { showDialog } from '@/lib/dialog';
import { hapticSuccess } from '@/lib/haptics';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import logger from '@/lib/logger';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useSectionVisitsStore } from '@/lib/stores/section-visits-store';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { toastManager } from '@/lib/toast-manager';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setConfirmTopicDelete, shouldConfirmTopicDelete } from './topic-delete-confirm';
import { leftOutStories, storiesPerTopic, type Story, type StoryFilter } from './fact-page-model';
import { sentenceCase } from './sentence-case';

/** How much a fact counts: 10% to 100% in 10% steps (`nudgeFactWeight`). */
const INFLUENCE_STEP = 0.1;
const INFLUENCE_MIN = 0.1;
const INFLUENCE_MAX = 1.0;
const GENERATE_MORE_TOPIC_COUNT = 10;
/** A typed Show less of phrase: a soft filter that never expires (owner Y4). */
const SOFT_STRENGTH = 0.5;

type Tab = 'topics' | 'recent';
interface TopicRow {
    readonly id: string;
    readonly text: string;
}
interface Chip {
    readonly key: string;
    readonly text: string;
    readonly remove: () => Promise<void>;
}

interface UseFactPageArgs {
    readonly factId: string;
    readonly from: 'feed' | 'you';
    readonly statement: string;
    readonly active: boolean;
}

export function useFactPage({ factId, from, statement }: UseFactPageArgs) {
    const { t } = useTranslation();

    const [tab, setTab] = useState<Tab>(from === 'feed' ? 'recent' : 'topics');
    const [filter, setFilter] = useState<StoryFilter>('all');

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
    const filterCount = (f: StoryFilter) => (f === 'all' ? total : f === 'suggested' ? impactful.length : leftOut.length);
    const filterLabel = (f: StoryFilter) =>
        f === 'all' ? t('facts.page.filterAll') : f === 'suggested' ? t('facts.page.filterSuggested') : t('facts.page.filterDiscarded');

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
        // As stored: Mera may set any value, and the slider shows it where it is.
        setInfluence(fact?.weight ?? 1);
    }, [fact?.id, fact?.weight]);
    const setWeight = useCallback(
        async (next: number) => {
            if (!fact || next === influence) return;
            const prev = influence;
            setInfluence(next);
            try {
                // The same write as before (one change-log row), as a delta from the stored value.
                await nudgeFactWeight(fact.id, next - (fact.weight ?? 1), 'user');
            } catch (err) {
                setInfluence(prev);
                logger.warn('[FactPage] influence nudge failed', { factId: fact.id, error: String(err) });
            }
        },
        [fact, influence],
    );

    // ── Topics: turn down, add, suggest more, retry ────────────────────────
    // A topic's delete is one tap; it asks first until "Don't ask again" is
    // ticked (topic-delete-confirm.ts; Settings › Your data turns it back on).
    const [confirmTopic, setConfirmTopic] = useState<TopicRow | null>(null);
    const [dontAsk, setDontAsk] = useState(false);
    const deleteTopic = useCallback(
        (topic: TopicRow) => {
            // A permanent decline: the persona agent never proposes it again
            // until it is lifted from the Show less of field below.
            deleteTopicWithDecline(topic.id).catch((error) =>
                logger.error('[FactPage] topic delete failed', error, { factId, topicId: topic.id }),
            );
        },
        [factId],
    );
    const askDeleteTopic = useCallback(
        async (topic: TopicRow) => {
            if (!(await shouldConfirmTopicDelete())) {
                deleteTopic(topic);
                return;
            }
            setDontAsk(false);
            setConfirmTopic(topic);
        },
        [deleteTopic],
    );
    const confirmDeleteTopic = useCallback(() => {
        const topic = confirmTopic;
        setConfirmTopic(null);
        if (!topic) return;
        if (dontAsk) void setConfirmTopicDelete(false);
        deleteTopic(topic);
    }, [confirmTopic, dontAsk, deleteTopic]);

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

    return {
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
    };
}

export { INFLUENCE_STEP, INFLUENCE_MIN, INFLUENCE_MAX };
export type { TopicRow };
