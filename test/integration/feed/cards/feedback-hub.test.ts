// The v6 feedback sheet's hub (useFeedbackHub) on the in-memory DB with the bundled v6 tree:
// answers apply at the tap, the verdict is written on the first answer, every answer lands on
// the dislike row (treePath = the first answer's path), and one toast sums up the session.
// Rows are driven through the drawn level's props; persona's fact writes are spied at the module.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type React from 'react';
import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import type { HubRow } from '@/components/custom/feedback-tree/FeedbackHubLevel';
import { useFeedbackHub, type FeedbackHubDeps, type HubLevel } from '@/components/custom/feedback-tree/use-feedback-hub';
import { BUNDLED_FEEDBACK_TREE } from '@/lib/algorithms/feedback-tree-snapshot';
import database from '@/lib/database';
import type ArticleFeedbackModel from '@/lib/database/models/ArticleFeedback';
import * as feedbackService from '@/lib/database/services/article-feedback-service';
import * as factService from '@/lib/database/services/fact-service';
import * as locationService from '@/lib/database/services/location-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { toastManager } from '@/lib/toast-manager';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import i18n from 'i18next';
import { initI18nEn } from '@/test/helpers';

const ARTICLE = 'hub-article';
const PUB = 'Realitatea';
const FACT = { id: 'fact-1', statement: 'Pensioner in India', topicIds: ['t1'] };
const SUBJECT: FeedbackSubject = {
    origin: 'suggestion',
    surface: 'for_you',
    articleId: ARTICLE,
    title: 'Pension indexation in 2027',
    publicationName: PUB,
    countryCode: 'RO',
    languageCode: 'ro',
};

const toastTitles = () =>
    useToastQueue.getState().entries.map((e) => {
        const props = (e.render({ id: e.id }) as { props: Record<string, any> }).props;
        return String(props.undone ? props.undoneTitle : props.title);
    });
const undoOfFirstToast = () => {
    const e = useToastQueue.getState().entries[0];
    return (e.render({ id: e.id }) as { props: { onUndo: () => Promise<unknown> } }).props.onUndo;
};
const row = async () =>
    (await database.get<ArticleFeedbackModel>('article_feedback').query().fetch()).find((r) => r.articleId === ARTICLE);
const ctxOf = async () => JSON.parse((await row())?.contextJson ?? '{}') as Record<string, any>;

function mount(over: Partial<FeedbackHubDeps> = {}) {
    let recorded = 0;
    const deps: FeedbackHubDeps = {
        t: i18n.t.bind(i18n) as FeedbackHubDeps['t'],
        subject: SUBJECT,
        context: { publicationName: PUB, countryCode: 'RO', matchedTopics: [], fact: FACT },
        tree: BUNDLED_FEEDBACK_TREE,
        ensureVerdict: jest.fn(async () => {
            if (recorded++ > 0) return;
            await feedbackService.recordVerdictFeedback({
                articleId: ARTICLE,
                sentiment: 'dislike',
                title: SUBJECT.title,
                contextJson: buildContextJson(SUBJECT),
            });
        }),
        push: jest.fn(),
        backToRoot: jest.fn(),
        closeThen: jest.fn((after?: () => void) => after?.()),
        ...over,
    };
    const hook = renderHook(() => useFeedbackHub(deps));
    const level = (l: HubLevel) =>
        (hook.result.current.renderLevel(l) as React.ReactElement<{ heading: string; subtitle?: string; rows: HubRow[] }>).props;
    const tap = async (l: HubLevel, testID: string) => {
        const r = level(l).rows.find((x) => x.testID === testID);
        if (!r) throw new Error(`no row ${testID}`);
        await act(async () => {
            r.onPress();
        });
    };
    return { deps, hook, level, tap };
}

const ROOT: HubLevel = { kind: 'tree', pathIds: [] };
const SITE: HubLevel = { kind: 'tree', pathIds: ['publication_issue'] };

beforeAll(async () => {
    await initI18nEn();
    /* eslint-disable @typescript-eslint/no-require-imports */
    require('@/lib/database/services/persona-action-executor');
    require('@/lib/database/services/persona-change-log-service');
    require('@/lib/toast-manager');
    require('@/components/custom/toast/UndoToast');
    require('@/components/ui/toast');
    /* eslint-enable @typescript-eslint/no-require-imports */
}, 60_000);

beforeEach(() => {
    resetToastQueue();
    toastManager.setToastInstance(toastApi);
    useFloatingChatStore.getState().reset();
});
afterEach(() => jest.restoreAllMocks());

describe('the hub root', () => {
    it('asks the question, quotes the fact, and ends with Tell Mera', () => {
        const { level } = mount();
        const root = level(ROOT);
        expect(root.heading).toBe("What's wrong with this story?");
        expect(root.subtitle).toBe('Mera showed this because of: Pensioner in India');
        expect(root.rows.map((r) => r.testID)).toEqual([
            'tree-row-profile_change',
            'tree-row-not_about_fact',
            'tree-row-wrong_place',
            'tree-row-publication_issue',
            'feedback-tell-mera',
        ]);
        expect(root.rows[1].label).toBe('This story isn\'t about "Pensioner in India"');
    });

    it('with no matched fact shows only the site row and no fact line', () => {
        const { level } = mount({ context: { publicationName: PUB, fact: null } });
        expect(level(ROOT).subtitle).toBeUndefined();
        expect(level(ROOT).rows.map((r) => r.key)).toEqual(['publication_issue', 'tell-mera']);
    });
});

describe('an answer', () => {
    it('applies at the tap, writes the verdict first, and stamps the row processed', async () => {
        const { deps, tap } = mount();
        await tap(SITE, 'tree-row-fewer_from_site');

        expect(deps.ensureVerdict).toHaveBeenCalled();
        await waitFor(async () => expect((await ctxOf()).answers).toHaveLength(1));
        expect(await getPreferenceKind(PUB)).toBe('deprioritize');
        const ctx = await ctxOf();
        expect(ctx.answers[0]).toEqual({ leafId: 'fewer_from_site', path: ['publication_issue', 'fewer_from_site'], cause: 'source' });
        // A row with no treePath is reaped at write: the first answer's path keeps it.
        expect(ctx.treePath).toEqual(['publication_issue', 'fewer_from_site']);
        expect(ctx.changeLogIds).toHaveLength(1);
        // Applied at the tap: the digest must not apply it a second time.
        expect(await feedbackService.getUnprocessedFeedback()).toHaveLength(0);
        // Sentry is off under jest, so no "Also let Mera Labs know" level: back at the hub.
        expect(deps.backToRoot).toHaveBeenCalled();
    });

    it('a mistake applies nothing, keeps the fact id and the story on device, and shows on its row', async () => {
        const { level, tap } = mount();
        await tap(ROOT, 'tree-row-not_about_fact');
        await waitFor(async () => expect((await ctxOf()).answers).toHaveLength(1));

        expect((await ctxOf()).answers[0]).toMatchObject({ leafId: 'not_about_fact', cause: 'system', value: 'fact-1' });
        expect(await feedbackService.getRecentSystemMistakes()).toEqual([
            expect.objectContaining({ reason: 'not_about_fact', factId: 'fact-1', country: 'RO', language: 'ro', publication: PUB }),
        ]);
        const root = level(ROOT);
        expect(root.heading).toBe('Anything else?');
        expect(root.subtitle).toBe('Pick another reason, or tap Done.');
        expect(root.rows.find((r) => r.key === 'not_about_fact')).toMatchObject({
            answered: true,
            subtitle: "Noted as Mera's mistake",
        });
    });

    it('a later unapplied answer keeps a row that applied something processed', async () => {
        const { tap } = mount();
        await tap(SITE, 'tree-row-fewer_from_site');
        await tap(ROOT, 'tree-row-not_about_fact');
        await waitFor(async () => expect((await ctxOf()).answers).toHaveLength(2));
        expect(await feedbackService.getUnprocessedFeedback()).toHaveLength(0);
        expect((await ctxOf()).treePath).toEqual(['publication_issue', 'fewer_from_site']);
    });

    it('"Stop news for this" goes through persona and is undoable', async () => {
        const stop = jest.spyOn(factService, 'stopNewsForFact').mockResolvedValue({ changeLogIds: ['c-stop'] });
        const { tap } = mount();
        await tap({ kind: 'tree', pathIds: ['profile_change', 'matters_less'] }, 'tree-row-stop_news');
        expect(stop).toHaveBeenCalledWith('fact-1');
        await waitFor(async () => expect((await ctxOf()).changeLogIds).toEqual(['c-stop']));
    });
});

describe('wrong place', () => {
    const options = [
        { place: 'IN', level: 'country' as const, label: 'India' },
        { place: 'IN|Madhya Pradesh|Bhopal', level: 'city' as const, label: 'Bhopal' },
        { place: 'GLOBAL', level: 'global' as const, label: 'Anywhere' },
    ];

    it('lists the options, and a pick sets the fact place as the reader`s', async () => {
        jest.spyOn(locationService, 'getAll').mockResolvedValue([]);
        jest.spyOn(factService, 'getFacts').mockResolvedValue([]);
        const set = jest.spyOn(factService, 'setFactPlaces').mockResolvedValue({ applied: true, changeLogId: 'c-place' });
        const { deps, level, tap } = mount();
        await tap(ROOT, 'tree-row-wrong_place');
        expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ kind: 'place' }));

        const place = level({ kind: 'place', options });
        expect(place.heading).toBe('Where should news for "Pensioner in India" come from?');
        expect(place.rows.map((r) => r.label)).toEqual(['India', 'Bhopal only', 'Any country is fine', 'Tell Mera']);
        await tap({ kind: 'place', options }, 'feedback-place-IN');

        expect(set).toHaveBeenCalledWith('fact-1', ['IN'], 'user');
        await waitFor(async () => expect((await ctxOf()).answers?.[0]).toMatchObject({ leafId: 'wrong_place', value: 'IN' }));
        expect(level(ROOT).rows.find((r) => r.key === 'wrong_place')?.subtitle).toBe('India');
    });

    it('leaving the screen without a pick asks persona to check again, and says so', async () => {
        jest.spyOn(locationService, 'getAll').mockResolvedValue([]);
        jest.spyOn(factService, 'getFacts').mockResolvedValue([]);
        const wrong = jest.spyOn(factService, 'markFactPlacesWrong').mockResolvedValue(true);
        const { hook, level, tap } = mount();
        await tap(ROOT, 'tree-row-wrong_place');
        act(() => hook.result.current.leavePlace());
        expect(wrong).toHaveBeenCalledWith('fact-1');
        expect(level(ROOT).rows.find((r) => r.key === 'wrong_place')?.subtitle).toBe('Mera will check this again');
    });
});

describe('the session toast', () => {
    it('sums up the session once the sheet has gone, and Undo reverts it all but keeps the verdict', async () => {
        const { hook, tap } = mount();
        await tap(SITE, 'tree-row-fewer_from_site');
        await tap(ROOT, 'tree-row-not_about_fact');
        await waitFor(async () => expect((await ctxOf()).answers).toHaveLength(2));

        act(() => hook.result.current.onSheetGone());
        // Only config answers count as changes; the site answer is neither.
        expect(toastTitles()).toEqual(["Mera's mistake noted"]);

        await act(async () => {
            await undoOfFirstToast()();
        });
        expect(await getPreferenceKind(PUB)).toBe('none');
        const after = await ctxOf();
        expect(after.answers).toBeUndefined();
        expect((await row())?.sentiment).toBe('dislike');
    });

    it('Done with no answer shows nothing and writes nothing', async () => {
        const { hook } = mount();
        act(() => hook.result.current.onSheetGone());
        expect(toastTitles()).toEqual([]);
        expect(await row()).toBeUndefined();
    });
});

describe('Tell Mera', () => {
    it('hands the host every answer, the screen and the fact', async () => {
        const onFeedbackChat = jest.fn();
        const { level, tap } = mount({ onFeedbackChat });
        await tap(ROOT, 'tree-row-not_about_fact');
        await tap(SITE, 'feedback-tell-mera');
        expect(onFeedbackChat).toHaveBeenCalledWith(['not_about_fact'], {
            answers: [{ cause: 'system', question: 'This story isn\'t about "Pensioner in India"', answer: "Noted as Mera's mistake" }],
            screen: level(SITE).heading,
            fact: 'Pensioner in India',
        });
    });

    it('without a host hand-off opens the feedback chat with the answers', async () => {
        const { tap } = mount();
        await tap(ROOT, 'feedback-tell-mera');
        expect(useFloatingChatStore.getState().context).toMatchObject({
            kind: 'article-suggestion',
            articleId: ARTICLE,
            verdict: 'dislike',
            feedbackAnswers: { answers: [], screen: "What's wrong with this story?", fact: 'Pensioner in India' },
        });
    });
});
