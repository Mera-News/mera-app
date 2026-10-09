// What a feedback-tree leaf does, through `performFeedbackLeaf` and `applyLeafActions`: the real persona-action
// executor, mutation rails, change log, article-feedback rows, publication preferences, toast manager over the
// real toast queue, floating-chat store and router mock. The host's callbacks (closeThen, onLeafPicked, showInfo)
// are plain arguments, so they are plain jest.fns. The one test that reaches the free-tier branch flips the dev
// AI-access override on the real feature-gates module (a compile-time constant, no module mock).
import { t } from 'i18next';
import { router } from 'expo-router';
import * as featureGates from '@/lib/config/feature-gates';
import { configure, waitFor } from '@testing-library/react-native';
import { applyLeafActions } from '@/components/custom/feedback-tree/apply-leaf-actions';
import { performFeedbackLeaf, type FeedbackLeafDeps } from '@/components/custom/feedback-tree/perform-feedback-leaf';
import database from '@/lib/database';
import type ArticleFeedbackModel from '@/lib/database/models/ArticleFeedback';
import * as feedbackService from '@/lib/database/services/article-feedback-service';
import * as changeLog from '@/lib/database/services/persona-change-log-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { createTopics, getActive, getWeightsByIds } from '@/lib/database/services/topic-service';
import type { FeedbackTreeNode } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { usePublicationDisplayStore } from '@/lib/stores/publication-display-store';
import { toastManager } from '@/lib/toast-manager';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import { initI18nEn } from '@/test/helpers';

// The first leaf loads the executor, change log and toast modules on demand; give it room under load.
configure({ asyncUtilTimeout: 20_000 });

const nav = router as unknown as { push: jest.Mock; navigate: jest.Mock };

const ARTICLE = 'article-1';
const PUB = 'The Hindu';
const PATH = ['not_interested', 'fewer_from_pub'];

/** The shown toasts as { title, body, onUndo }, read off the queue's rendered cards. The Undo card carries
 *  its text as props; an info toast carries its title as the first child's text. */
const toasts = () =>
    useToastQueue.getState().entries.map((e) => {
        const props = (e.render({ id: e.id }) as { props: Record<string, any> }).props;
        return {
            title: String(props.title ?? props.children?.[0]?.props?.children),
            body: props.body as string | undefined,
            onUndo: props.onUndo as (() => void) | undefined,
        };
    });

const leafNode = (leaf: FeedbackTreeNode['leaf']): FeedbackTreeNode => ({
    id: 'leaf',
    labelKey: 'k',
    labelDefault: 'Leaf',
    leaf,
});
const pubLeaf = (value: 'deprioritize' | 'mute' | 'boost') =>
    leafNode({ actions: [{ type: 'set_publication_pref', value }] });

function deps(over: Partial<FeedbackLeafDeps> = {}): FeedbackLeafDeps {
    return {
        context: { publicationName: PUB },
        chatContext: { kind: 'persona' },
        chatMessage: 'Why this story?',
        label: 'Fewer from The Hindu',
        spend: { articleId: ARTICLE, sentiment: 'dislike' },
        closeThen: jest.fn((after?: () => void) => after?.()),
        onLeafPicked: jest.fn(),
        showInfo: jest.fn(),
        chrome: (key, def, vars) => t(`feedbackTree.${key}`, { defaultValue: def, ...vars }) as string,
        ...over,
    };
}

/** A dislike verdict whose tree path is already recorded, so it starts unprocessed. */
const seedVerdict = () =>
    feedbackService.recordVerdictFeedback({
        articleId: ARTICLE,
        sentiment: 'dislike',
        title: 'A story',
        contextJson: JSON.stringify({ treePath: PATH }),
    });

/** The change-log ids the verdict row remembers (what un-voting would revert). */
async function storedChangeLogIds(): Promise<string[]> {
    const rows = await database.get<ArticleFeedbackModel>('article_feedback').query().fetch();
    const ctx = JSON.parse(rows[0]?.contextJson ?? '{}') as { changeLogIds?: string[] };
    return ctx.changeLogIds ?? [];
}

const pickedAfter = async (d: FeedbackLeafDeps) => {
    await waitFor(() => expect(d.onLeafPicked).toHaveBeenCalled());
    return (d.onLeafPicked as jest.Mock).mock.calls[0];
};

beforeAll(async () => {
    await initI18nEn();
});

afterEach(() => {
    jest.restoreAllMocks();
    resetToastQueue();
});

beforeEach(() => {
    resetToastQueue();
    toastManager.setToastInstance(toastApi);
    useFloatingChatStore.getState().reset();
    usePublicationDisplayStore.setState({ language: null, names: {} });
});

describe('a leaf with persona actions', () => {
    it('writes the preference and the change log, spends the verdict, and shows an Undo toast', async () => {
        await seedVerdict();
        const d = deps();
        performFeedbackLeaf(pubLeaf('deprioritize'), PATH, d);

        // The sheet closes at the tap, before the write lands.
        expect(d.closeThen).toHaveBeenCalledWith();
        expect(await pickedAfter(d)).toEqual([PATH, 1, true]);

        expect(await getPreferenceKind(PUB)).toBe('deprioritize');
        const [log] = await changeLog.getRecent();
        expect(log).toMatchObject({ actionType: 'set_publication_pref', source: 'feedback', reverted: false });
        expect(JSON.parse(log.actionJson)).toMatchObject({ targetId: PUB, before: 'none', after: 'deprioritize' });

        expect(await storedChangeLogIds()).toEqual([log.id]);
        expect(await feedbackService.getUnprocessedFeedback()).toHaveLength(0);

        expect(toasts()).toEqual([
            expect.objectContaining({ title: 'Got it: feed updated', body: 'Fewer from The Hindu' }),
        ]);
    });

    it('a topic-weight leaf nudges every matched topic and logs one entry each', async () => {
        const [a, b] = await createTopics([
            { text: 'formula 1', weight: 0.5 },
            { text: 'motogp', weight: 0.5 },
        ]);
        await seedVerdict();
        const d = deps({
            context: { matchedTopics: [{ topicId: a.id, text: a.text }, { topicId: b.id, text: b.text }] },
        });
        performFeedbackLeaf(leafNode({ actions: [{ type: 'set_topic_weight', topics: 'matched', delta: -0.15 }] }), PATH, d);

        expect((await pickedAfter(d))[1]).toBe(2);
        const weights = await getWeightsByIds([a.id, b.id]);
        expect(weights.map((w) => w.weight).sort()).toEqual([0.35, 0.35]);
        expect((await changeLog.getRecent()).map((r) => r.actionType)).toEqual(['set_topic_weight', 'set_topic_weight']);
        expect(await storedChangeLogIds()).toHaveLength(2);
    });

    it('a negative-topic leaf mints the topic from the article place', async () => {
        const d = deps({ context: { geoText: 'Gaza' } });
        performFeedbackLeaf(leafNode({ actions: [{ type: 'add_negative_topic', text: 'from_context_geo', weight: -0.6 }] }), PATH, d);
        expect((await pickedAfter(d))[1]).toBe(1);
        const minted = (await getActive()).find((t) => t.text === 'Gaza');
        expect(minted).toMatchObject({ weight: -0.6, provenance: 'feedback' });
    });

    it('Undo restores the preference, marks the log row reverted and confirms with a second toast', async () => {
        const d = deps();
        performFeedbackLeaf(pubLeaf('mute'), PATH, d);
        await pickedAfter(d);
        expect(await getPreferenceKind(PUB)).toBe('mute');

        toasts()[0].onUndo?.();
        await waitFor(() => expect(toasts().map((t) => t.title)).toContain('Change undone'));
        expect(await getPreferenceKind(PUB)).toBe('none');
        expect((await changeLog.getRecent()).find((r) => r.actionType === 'set_publication_pref')?.reverted).toBe(true);
    });

    it('Undo claims nothing when a newer change owns the value', async () => {
        const first = deps();
        performFeedbackLeaf(pubLeaf('deprioritize'), PATH, first);
        await pickedAfter(first);
        const staleUndo = toasts()[0].onUndo;

        // A second leaf changes the same publication afterwards.
        const second = deps();
        performFeedbackLeaf(pubLeaf('mute'), PATH, second);
        await pickedAfter(second);
        expect(toasts()).toHaveLength(2);

        const revert = jest.spyOn(changeLog, 'revertChange');
        staleUndo?.();
        await waitFor(() => expect(revert).toHaveBeenCalled());
        await expect(revert.mock.results[0].value).resolves.toBe(false);
        await new Promise((r) => setImmediate(r));
        expect(toasts().map((t) => t.title)).not.toContain('Change undone');
        expect(await getPreferenceKind(PUB)).toBe('mute');
    });

    it('applies nothing once the topic has used up its daily nudge budget', async () => {
        const [t] = await createTopics([{ text: 'cricket', weight: 0.5 }]);
        const nudge = (delta: number) =>
            leafNode({ actions: [{ type: 'set_topic_weight', topics: 'matched', delta }] });
        const ctx = { matchedTopics: [{ topicId: t.id, text: t.text }] };

        const first = deps({ context: ctx });
        performFeedbackLeaf(nudge(-0.3), PATH, first);
        expect((await pickedAfter(first))[1]).toBe(1);
        resetToastQueue();

        const over = deps({ context: ctx });
        performFeedbackLeaf(nudge(-0.15), PATH, over);
        // Still a reason the user gave (committed), but nothing changed and no toast claims otherwise.
        expect(await pickedAfter(over)).toEqual([PATH, 0, true]);
        expect(toasts()).toEqual([]);
        expect((await getWeightsByIds([t.id]))[0].weight).toBe(0.2);
    });
});

describe('a leaf with no persona actions', () => {
    it('whose placeholders cannot be resolved thanks the reader and commits', () => {
        const d = deps({ context: {} });
        performFeedbackLeaf(pubLeaf('mute'), PATH, d);
        expect(d.onLeafPicked).toHaveBeenCalledWith(PATH, 0, true);
        expect(d.showInfo).toHaveBeenCalledWith('Thanks for the feedback');
        expect(toasts()).toEqual([]);
    });

    it('"I have seen this" acknowledges but does not commit', () => {
        const d = deps();
        performFeedbackLeaf(leafNode({ seenOnly: true }), PATH, d);
        expect(d.onLeafPicked).toHaveBeenCalledWith(PATH, 0, false);
        expect(d.showInfo).toHaveBeenCalledWith("Got it: we'll show fewer you've seen");
    });

    it('a leaf without a payload does nothing at all', () => {
        const d = deps();
        performFeedbackLeaf({ id: 'branch', labelKey: 'k', labelDefault: 'Branch' }, PATH, d);
        expect(d.closeThen).not.toHaveBeenCalled();
        expect(d.onLeafPicked).not.toHaveBeenCalled();
    });
});

describe('nudge leaves', () => {
    it('manage_publication opens Sources in the You tab after the sheet closes', () => {
        const d = deps();
        performFeedbackLeaf(leafNode({ nudge: 'manage_publication' }), PATH, d);
        expect(d.onLeafPicked).toHaveBeenCalledWith(PATH, 0, true);
        expect(nav.navigate).toHaveBeenCalledWith('/logged-in/app_container/you');
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/logged-in/app_container/you/sources', params: {} });
    });

    it('subscribe names the publication by its display name', () => {
        usePublicationDisplayStore.setState({ language: 'en', names: { '人民日报': 'Renmin Ribao' } });
        const d = deps({ context: { publicationName: '人民日报' } });
        performFeedbackLeaf(leafNode({ nudge: 'subscribe' }), PATH, d);
        expect(d.showInfo).toHaveBeenCalledWith('Subscribing to Renmin Ribao unlocks full articles');
    });

    it('subscribe falls back to the raw name when no display name is known', () => {
        const d = deps({ context: { publicationName: '人民日报' } });
        performFeedbackLeaf(leafNode({ nudge: 'subscribe' }), PATH, d);
        expect(d.showInfo).toHaveBeenCalledWith('Subscribing to 人民日报 unlocks full articles');
    });

    it('browse_related goes to the host destination when it gives one, else a toast', () => {
        const browseRelated = jest.fn();
        const withHost = deps({ browseRelated });
        performFeedbackLeaf(leafNode({ nudge: 'browse_related' }), PATH, withHost);
        expect(withHost.closeThen).toHaveBeenCalledWith(browseRelated);
        expect(withHost.showInfo).not.toHaveBeenCalled();

        const bare = deps();
        performFeedbackLeaf(leafNode({ nudge: 'browse_related' }), PATH, bare);
        expect(bare.showInfo).toHaveBeenCalledWith('Look for related coverage from other sources');
    });
});

describe('an openChat leaf', () => {
    it('hands off to the Mera chat with the verdict message once the sheet has gone', () => {
        const d = deps();
        performFeedbackLeaf(leafNode({ openChat: true }), PATH, d);
        const chat = useFloatingChatStore.getState();
        expect(chat.isExpanded).toBe(true);
        expect(chat.context).toEqual({ kind: 'persona' });
        expect(chat.pendingInitialMessage).toBe('Why this story?');
        expect(d.onLeafPicked).not.toHaveBeenCalled();
    });

    it('uses the host hand-off when it gives one', () => {
        const openChat = jest.fn();
        const d = deps({ openChat });
        performFeedbackLeaf(leafNode({ openChat: true }), PATH, d);
        expect(openChat).toHaveBeenCalledTimes(1);
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });

    it('on Mera News Free persists the tapped path as a reason and opens nothing', () => {
        jest.replaceProperty(featureGates as never, 'DEV_FORCE_AI_ACCESS' as never, 'locked' as never);
        const d = deps();
        performFeedbackLeaf(leafNode({ openChat: true }), PATH, d);
        expect(d.onLeafPicked).toHaveBeenCalledWith(PATH, 0, true);
        expect(d.closeThen).toHaveBeenCalledWith();
        expect(useFloatingChatStore.getState().isExpanded).toBe(false);
    });
});

describe('applyLeafActions', () => {
    const ACTIONS = [{ action_type: 'add_negative_topic' as const, topicText: 'Gossip', weight: -0.6 }];

    it('does nothing for an empty list', async () => {
        await expect(applyLeafActions([], 'x')).resolves.toBe(0);
        expect(toasts()).toEqual([]);
        expect(await changeLog.getRecent()).toEqual([]);
    });

    it('shows the Undo toast as soon as the persona write lands, before the spend bookkeeping', async () => {
        await seedVerdict();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const spy = jest.spyOn(feedbackService, 'recordFeedbackChangeLogIds').mockImplementationOnce(() => gate);
        try {
            const done = applyLeafActions(ACTIONS, 'Not that important', { articleId: ARTICLE, sentiment: 'dislike' });
            await waitFor(() => expect(spy).toHaveBeenCalled());
            // The bookkeeping is still pending, and the reader already has the toast.
            expect(toasts()).toEqual([expect.objectContaining({ title: 'Got it: feed updated', body: 'Not that important' })]);
            release();
            await expect(done).resolves.toBe(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('returns 0 and shows nothing when the executor applied nothing', async () => {
        // A weight-less topic id: the executor skips it rather than throwing.
        const result = await applyLeafActions([{ action_type: 'set_topic_weight' as const, delta: -0.1 }], 'x');
        expect(result).toBe(0);
        expect(toasts()).toEqual([]);
    });

    it('does not spend a verdict when given none', async () => {
        await seedVerdict();
        await applyLeafActions(ACTIONS, 'x');
        expect(await feedbackService.getUnprocessedFeedback()).toHaveLength(1);
    });
});
