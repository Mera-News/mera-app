// The v6 feedback sheet: hub and spoke inside the one ••• sheet (useArticleMenu
// owns the sheet, its stack and the dismissal). The root lists the reasons; a
// reader answers one, comes back to "Anything else?", and may add another.
//
// Every answer applies at the tap and is appended to the article's dislike row
// (`recordFeedbackAnswer`); the verdict itself is written on the FIRST answer
// (`ensureVerdict`), never on open. When the sheet has gone, ONE toast sums up
// the session ("N changes saved", "Mera's mistake noted", both, or "Feedback
// saved"), and its Undo reverts every change and drops the session's answers;
// the verdict stays. Done with no answer changes nothing.
//
// Database, fact and Sentry modules are required at call time: this hook sits
// under every card.

import FeedbackHubLevel, { type HubRow } from '@/components/custom/feedback-tree/FeedbackHubLevel';
import { applyLeafActions } from '@/components/custom/feedback-tree/apply-leaf-actions';
import { summaryToast } from '@/components/custom/feedback-tree/answer-summary';
import {
    feedbackLabelVars,
    feedbackNodeAnswer,
    feedbackNodeLabel,
    type FeedbackLabelContext,
} from '@/components/custom/feedback-tree/label-vars';
import { resolveTreeLevel } from '@/components/custom/feedback-tree/useFeedbackTreeEngine';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import type { FeedbackAnswersHandoff, FeedbackCause } from '@/lib/news-harness/core/types';
import { resolveLeafActions } from '@/lib/news-harness/feedback-tree/resolve-leaf-actions';
import type { FeedbackTree, FeedbackTreeNode } from '@/lib/news-harness/feedback-tree/types';
import type { FactPlaceOption } from '@/lib/news-harness/persona-management/fact-places';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import type { TFunction } from 'i18next';
import React, { useCallback, useRef, useState } from 'react';

/** The sheet levels this hook draws (the menu keeps its own). */
export type HubLevel =
    | { kind: 'tree'; pathIds: string[] }
    | { kind: 'tree-confirm'; node: FeedbackTreeNode; pathIds: string[] }
    | { kind: 'place'; options: FactPlaceOption[] }
    | { kind: 'report' };

interface SessionAnswer {
    leafId: string;
    path: string[];
    cause: FeedbackCause;
    /** The root row it answers (the first id of its path). */
    rootId: string;
    /** What the answered row says ("Less for this", "From India"). */
    answer: string;
    changeLogIds: string[];
    sent?: boolean;
}

export interface FeedbackHubDeps {
    t: TFunction;
    subject: FeedbackSubject;
    /** The tree context with the publication's display name (labels). */
    context: FeedbackLabelContext;
    tree: FeedbackTree | null;
    /** Writes the dislike verdict once per article (the first answer). */
    ensureVerdict: () => Promise<void>;
    push: (level: HubLevel) => void;
    /** Pop back to the hub's root level. */
    backToRoot: () => void;
    closeThen: (after?: () => void) => void;
    /** Tell Mera: the host's hand-off (Feed, detail). Omitted: the generic chat. */
    onFeedbackChat?: (pathIds: string[], answers: FeedbackAnswersHandoff) => void;
}

type TellHint =
    | 'feedbackTree.menu.tellRoot'
    | 'feedbackTree.menu.tellProfile'
    | 'feedbackTree.menu.tellPlace'
    | 'feedbackTree.menu.tellSite'
    | 'feedbackTree.menu.tellTrust'
    | 'feedbackTree.menu.tellReport';
type BranchHeading =
    | 'feedbackTree.menu.profileTitle'
    | 'feedbackTree.menu.lessTitle'
    | 'feedbackTree.menu.siteTitle'
    | 'feedbackTree.menu.trustTitle';

/** A branch level's heading and its Tell Mera hint, by the branch's id. */
const HEADINGS: Record<string, { key: BranchHeading; tell: TellHint }> = {
    profile_change: { key: 'feedbackTree.menu.profileTitle', tell: 'feedbackTree.menu.tellProfile' },
    matters_less: { key: 'feedbackTree.menu.lessTitle', tell: 'feedbackTree.menu.tellProfile' },
    publication_issue: { key: 'feedbackTree.menu.siteTitle', tell: 'feedbackTree.menu.tellSite' },
    not_factual: { key: 'feedbackTree.menu.trustTitle', tell: 'feedbackTree.menu.tellTrust' },
};

/** A destructive leaf asks first (a pushed confirm level). */
function leafNeedsConfirm(node: FeedbackTreeNode): boolean {
    return !!node.leaf?.confirm && (node.leaf.actions?.length ?? 0) > 0;
}

/** A place option as its row reads: GLOBAL is "Any country is fine", a region
 *  or a city reads "<name> only". */
function placeLabel(t: TFunction, o: FactPlaceOption): string {
    if (o.level === 'global') return t('feedbackTree.menu.anyCountry');
    if (o.level === 'region' || o.level === 'city') return t('feedbackTree.menu.placeOnly', { place: o.label });
    return o.label;
}

/** A country name from either code form the app stores (alpha-2 or alpha-3). */
function countryNameOf(code: string | null | undefined): string | null {
    if (!code) return null;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getCountryName } = require('@/lib/algorithms/country-utils') as typeof import('@/lib/algorithms/country-utils');
    const countries = require('i18n-iso-countries') as typeof import('i18n-iso-countries');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const alpha3 = code.length === 2 ? countries.alpha2ToAlpha3(code.toUpperCase()) : code.toUpperCase();
    return alpha3 ? getCountryName(alpha3) : null;
}

export function useFeedbackHub(d: FeedbackHubDeps) {
    const { t, subject, context, tree } = d;
    const [answers, setAnswers] = useState<SessionAnswer[]>([]);
    const answersRef = useRef<SessionAnswer[]>([]);
    answersRef.current = answers;
    const [focusKey, setFocusKey] = useState(0);
    // The place screen was opened and nothing picked yet.
    const placeOpenRef = useRef(false);
    // "Choose a country" handed over to the country picker (after the sheet).
    const [pickerOpen, setPickerOpen] = useState(false);
    const pickerPendingRef = useRef(false);
    // DB writes run in tap order, one after another.
    const writes = useRef<Promise<void>>(Promise.resolve());
    const busy = useRef(false);
    const depsRef = useRef(d);
    depsRef.current = d;

    const label = useCallback((node: FeedbackTreeNode) => feedbackNodeLabel(t, node, context), [t, context]);
    const fact = context.fact ?? null;
    const site = context.publicationDisplayName || context.publicationName || '';

    const reset = useCallback(() => {
        setAnswers([]);
        placeOpenRef.current = false;
    }, []);

    /** Persist one answer (after the verdict), keep it for the toast, and show
     *  it on its root row. */
    const record = useCallback(
        (node: FeedbackTreeNode, path: string[], a: { answer: string; changeLogIds?: string[]; value?: string }): SessionAnswer => {
            const entry: SessionAnswer = {
                leafId: node.id,
                path,
                cause: node.leaf?.cause ?? 'config',
                rootId: path[0] ?? node.id,
                answer: a.answer,
                changeLogIds: a.changeLogIds ?? [],
            };
            setAnswers((prev) => [...prev, entry]);
            const { subject: s, ensureVerdict } = depsRef.current;
            const factId = depsRef.current.context.fact?.id ?? null;
            writes.current = writes.current.then(async () => {
                await ensureVerdict();
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const svc = require('@/lib/database/services/article-feedback-service') as typeof import('@/lib/database/services/article-feedback-service');
                await svc.recordFeedbackAnswer(
                    s.articleId,
                    { leafId: entry.leafId, path, cause: entry.cause, ...(a.value ? { value: a.value } : {}) },
                    { applied: entry.changeLogIds.length > 0, factId },
                );
                // Un-voting reverts exactly these.
                await svc.recordFeedbackChangeLogIds(s.articleId, 'dislike', entry.changeLogIds);
            }).catch(() => undefined);
            return entry;
        },
        [],
    );

    const afterAnswer = useCallback(
        (cause: FeedbackCause) => {
            // A site problem may also go to Mera Labs; everything else is back at the hub.
            if (cause === 'source' && SENTRY_ENABLED) depsRef.current.push({ kind: 'report' });
            else {
                depsRef.current.backToRoot();
                setFocusKey((k) => k + 1);
            }
        },
        [],
    );

    /** A leaf was tapped (a confirmed one, too). */
    const answerLeaf = useCallback(
        async (node: FeedbackTreeNode, pathIds: string[]) => {
            const leaf = node.leaf;
            if (!leaf || busy.current) return;
            const f = depsRef.current.context.fact;
            busy.current = true;
            try {
                if (leaf.nudge === 'place_picker') {
                    if (!f) return;
                    /* eslint-disable @typescript-eslint/no-require-imports */
                    const { getAll } = require('@/lib/database/services/location-service') as typeof import('@/lib/database/services/location-service');
                    const { suggestFactPlaceOptions } = require('@/lib/news-harness/persona-management/fact-places') as typeof import('@/lib/news-harness/persona-management/fact-places');
                    const { getFacts } = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
                    /* eslint-enable @typescript-eslint/no-require-imports */
                    const [rows, facts] = await Promise.all([getAll(), getFacts()]);
                    const full = facts.find((x) => x.id === f.id);
                    const places = rows.map((l) => ({
                        countryCode: (l.countryCode ?? '').toUpperCase(),
                        region: l.region ?? null,
                        city: l.city ?? null,
                        role: l.role,
                    }));
                    placeOpenRef.current = true;
                    depsRef.current.push({
                        kind: 'place',
                        options: suggestFactPlaceOptions(full ?? { statement: f.statement }, places),
                    });
                    return;
                }
                if (leaf.nudge === 'stop_news') {
                    if (!f) return;
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { stopNewsForFact } = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
                    const { changeLogIds } = await stopNewsForFact(f.id);
                    record(node, pathIds, { answer: feedbackNodeAnswer(t, node, context), changeLogIds });
                    afterAnswer('config');
                    return;
                }
                if (leaf.nudge === 'open_fact') {
                    record(node, pathIds, { answer: label(node) });
                    depsRef.current.closeThen(() => {
                        if (!f) return;
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { openFactPage } = require('@/components/custom/facts/open-fact-page') as typeof import('@/components/custom/facts/open-fact-page');
                        openFactPage(f);
                    });
                    return;
                }
                const actions = resolveLeafActions(leaf, depsRef.current.context);
                const { changeLogIds } = await applyLeafActions(actions);
                const cause = leaf.cause ?? 'config';
                record(node, pathIds, {
                    answer: feedbackNodeAnswer(t, node, context),
                    changeLogIds,
                    ...(cause === 'system' && f ? { value: f.id } : {}),
                });
                afterAnswer(cause);
            } finally {
                busy.current = false;
            }
        },
        [record, afterAnswer, t, context, label],
    );

    /** The reader picked a place for the fact (`places_by: user`). */
    const pickPlace = useCallback(
        async (o: FactPlaceOption) => {
            const f = depsRef.current.context.fact;
            const node = tree ? resolveTreeLevel(tree, [], depsRef.current.context).findNode('wrong_place') : null;
            if (!f || !node || busy.current) return;
            busy.current = true;
            try {
                placeOpenRef.current = false;
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { setFactPlaces } = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
                const res = await setFactPlaces(f.id, [o.place], 'user');
                record(node, ['wrong_place'], {
                    answer: placeLabel(t, o),
                    value: o.place,
                    changeLogIds: res.changeLogId ? [res.changeLogId] : [],
                });
                afterAnswer('config');
            } finally {
                busy.current = false;
            }
        },
        [tree, record, afterAnswer, t],
    );

    /** The place screen closed with no pick: the sweep decides that fact again,
     *  and the row says so. Called by the menu on Back and on dismissal. */
    const leavePlace = useCallback(() => {
        if (!placeOpenRef.current) return;
        placeOpenRef.current = false;
        const f = depsRef.current.context.fact;
        const node = tree ? resolveTreeLevel(tree, [], depsRef.current.context).findNode('wrong_place') : null;
        if (!f || !node) return;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { markFactPlacesWrong } = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
        void markFactPlacesWrong(f.id);
        record(node, ['wrong_place'], { answer: t('feedbackTree.menu.willRecheck') });
    }, [tree, record, t]);

    /** The prefilled Report a bug for the latest system or source answer. */
    const reportToLabs = useCallback(() => {
        const list = answersRef.current;
        const idx = list.map((a) => a.cause !== 'config').lastIndexOf(true);
        if (idx < 0) return;
        const target = list[idx];
        const node = tree ? resolveTreeLevel(tree, [], depsRef.current.context).findNode(target.leafId) : null;
        setAnswers((prev) => prev.map((a, i) => (i === idx ? { ...a, sent: true } : a)));
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { buildBugPrefill } = require('@/components/custom/feedback-tree/bug-prefill') as typeof import('@/components/custom/feedback-tree/bug-prefill');
        const { getLanguageNameIn } = require('@/lib/algorithms/language-names') as typeof import('@/lib/algorithms/language-names');
        const { useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store') as typeof import('@/lib/stores/mera-protocol-store');
        const { ProcessingMode } = require('@/lib/generated/graphql-types') as typeof import('@/lib/generated/graphql-types');
        const { showFeedback } = require('@/lib/feedback') as typeof import('@/lib/feedback');
        const i18n = (require('@/lib/i18n') as typeof import('@/lib/i18n')).default;
        /* eslint-enable @typescript-eslint/no-require-imports */
        const s = depsRef.current.subject;
        const prefill = buildBugPrefill(t, {
            reason: node ? label(node) : target.answer,
            site,
            countryName: countryNameOf(s.countryCode) ?? '',
            languageName: getLanguageNameIn(s.languageCode, i18n.language) ?? '',
            scorer: useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice ? 'phone' : 'cloud',
        });
        depsRef.current.closeThen(() => showFeedback({ prefill }));
    }, [tree, t, label, site]);

    /** Tell Mera, from any screen: the existing feedback chat, handed every
     *  answer so far and the screen the reader is on. */
    const tellMera = useCallback(
        (screen: string) => {
            const list = answersRef.current;
            const rootLabel = (id: string) => {
                const n = tree ? resolveTreeLevel(tree, [], depsRef.current.context).findNode(id) : null;
                return n ? label(n) : id;
            };
            const handoff: FeedbackAnswersHandoff = {
                answers: list.map((a) => ({ cause: a.cause, question: rootLabel(a.rootId), answer: a.answer })),
                screen,
                ...(fact ? { fact: fact.statement } : {}),
            };
            const path = list[0]?.path ?? [];
            const { onFeedbackChat, closeThen, subject: s } = depsRef.current;
            closeThen(() => {
                if (onFeedbackChat) {
                    onFeedbackChat(path, handoff);
                    return;
                }
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { useFloatingChatStore } = require('@/lib/stores/floating-chat-store') as typeof import('@/lib/stores/floating-chat-store');
                useFloatingChatStore.getState().openArticleFeedback(
                    {
                        kind: 'article-suggestion',
                        articleId: s.articleId,
                        suggestionId: s.suggestionId,
                        articleTitle: s.title,
                        verdict: 'dislike',
                        feedbackAnswers: handoff,
                    },
                    t('articleFeedback.thumbsDownMessage', { title: s.title }),
                );
            });
        },
        [tree, label, fact, t],
    );

    /** One toast for these answers, with an Undo for all of them. */
    const summarize = useCallback(
        (list: SessionAnswer[]) => {
            const title = summaryToast(t, list);
            if (!title) return;
            const s = depsRef.current.subject;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
            toastManager.showUndoToast({
                title,
                undoLabel: t('articleMenu.undo'),
                undoTestID: 'feedback-undo',
                undoneTitle: t('feedbackTree.undoneTitle'),
                onUndo: async () => {
                    /* eslint-disable @typescript-eslint/no-require-imports */
                    const { revertChange } = require('@/lib/database/services/persona-change-log-service') as typeof import('@/lib/database/services/persona-change-log-service');
                    const svc = require('@/lib/database/services/article-feedback-service') as typeof import('@/lib/database/services/article-feedback-service');
                    /* eslint-enable @typescript-eslint/no-require-imports */
                    await writes.current;
                    for (const id of list.flatMap((a) => a.changeLogIds)) {
                        try {
                            await revertChange(id);
                        } catch {
                            /* best effort, per id: a newer change may own the value */
                        }
                    }
                    await svc.dropLastFeedbackAnswers(s.articleId, list.length);
                    return true;
                },
            });
        },
        [t],
    );

    /** The sheet has gone: one toast for the session. */
    const onSheetGone = useCallback(() => {
        if (!pickerPendingRef.current) leavePlace();
        const list = answersRef.current;
        reset();
        summarize(list);
    }, [leavePlace, reset, summarize]);

    /** "Choose a country" (no suggested place): persona's country picker, a
     *  Modal of its own, so it opens once this sheet has gone. Its answer gets
     *  its own toast. */
    const openPicker = useCallback(() => {
        placeOpenRef.current = false;
        pickerPendingRef.current = true;
        depsRef.current.closeThen(() => setPickerOpen(true));
    }, []);
    const finishPicker = useCallback(
        async (alpha2: string | null) => {
            setPickerOpen(false);
            pickerPendingRef.current = false;
            const f = depsRef.current.context.fact;
            const node = tree ? resolveTreeLevel(tree, [], depsRef.current.context).findNode('wrong_place') : null;
            if (!f || !node) return;
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const factSvc = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
            let entry: SessionAnswer;
            if (alpha2) {
                const res = await factSvc.setFactPlaces(f.id, [alpha2], 'user');
                entry = record(node, ['wrong_place'], {
                    answer: countryNameOf(alpha2) ?? alpha2,
                    value: alpha2,
                    changeLogIds: res.changeLogId ? [res.changeLogId] : [],
                });
            } else {
                void factSvc.markFactPlacesWrong(f.id);
                entry = record(node, ['wrong_place'], { answer: t('feedbackTree.menu.willRecheck') });
            }
            reset();
            summarize([entry]);
        },
        [tree, record, reset, summarize, t],
    );
    const pickerElement = pickerOpen
        ? (() => {
              // Required at render time, and only while open: the picker's graph is
              // not the card's.
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { CountryPickerSheet } = require('@/components/custom/facts/CountryPickerSheet') as typeof import('@/components/custom/facts/CountryPickerSheet');
              return (
                  <CountryPickerSheet
                      visible
                      onPick={(alpha2) => void finishPicker(alpha2)}
                      onClose={() => void finishPicker(null)}
                  />
              );
          })()
        : null;

    // ── Drawing ────────────────────────────────────────────────────────────
    const tellRow = (hint: TellHint, screen: string): HubRow => ({
        key: 'tell-mera',
        testID: 'feedback-tell-mera',
        label: t('feedbackTree.menu.tellMera'),
        subtitle: t(hint),
        icon: 'mera',
        opensLevel: true,
        onPress: () => tellMera(screen),
    });
    const fullLabel = (node: FeedbackTreeNode) => feedbackNodeLabel(t, node, context, { fullFact: true });
    const nodeRow = (node: FeedbackTreeNode, pathIds: string[], hasChildren: boolean): HubRow => ({
        key: node.id,
        testID: `tree-row-${node.id}`,
        label: label(node),
        a11yLabel: fullLabel(node),
        icon: (node.icon as HubRow['icon']) || 'chevron-right',
        opensLevel: hasChildren || node.leaf?.nudge === 'place_picker',
        onPress: () => {
            if (hasChildren) depsRef.current.push({ kind: 'tree', pathIds: [...pathIds, node.id] });
            else if (leafNeedsConfirm(node)) depsRef.current.push({ kind: 'tree-confirm', node, pathIds: [...pathIds, node.id] });
            else void answerLeaf(node, [...pathIds, node.id]);
        },
    });

    const renderLevel = (level: HubLevel): React.ReactNode => {
        if (!tree) return null;
        if (level.kind === 'place') {
            const heading = t('feedbackTree.menu.placeTitle', { fact: feedbackLabelVars(context).fact });
            const country = countryNameOf(subject.countryCode);
            return (
                <FeedbackHubLevel
                    heading={heading}
                    rows={[
                        ...(level.options.some((o) => o.level !== 'global')
                            ? []
                            : [
                                  {
                                      key: 'choose-country',
                                      testID: 'feedback-place-choose',
                                      label: t('feedbackTree.menu.chooseCountry'),
                                      icon: 'search' as const,
                                      opensLevel: true,
                                      onPress: openPicker,
                                  },
                              ]),
                        ...level.options.map<HubRow>((o) => ({
                            key: o.place,
                            testID: `feedback-place-${o.place}`,
                            label: placeLabel(t, o),
                            icon: o.level === 'global' ? 'public' : 'location-on',
                            onPress: () => void pickPlace(o),
                        })),
                        tellRow('feedbackTree.menu.tellPlace', heading),
                    ]}
                    note={site && country ? t('feedbackTree.menu.placeNote', { site, country }) : undefined}
                />
            );
        }
        if (level.kind === 'report') {
            const heading = t('feedbackTree.menu.reportTitle', { site });
            return (
                <FeedbackHubLevel
                    heading={heading}
                    rows={[
                        { key: 'yes', testID: 'feedback-report-yes', label: t('feedbackTree.menu.reportYes'), icon: 'send', onPress: reportToLabs },
                        {
                            key: 'no',
                            testID: 'feedback-report-no',
                            label: t('feedbackTree.menu.reportNo'),
                            icon: 'close',
                            onPress: () => {
                                depsRef.current.backToRoot();
                                setFocusKey((k) => k + 1);
                            },
                        },
                        tellRow('feedbackTree.menu.tellReport', heading),
                    ]}
                    note={t('feedbackTree.menu.reportFootnote')}
                />
            );
        }
        if (level.kind === 'tree-confirm') {
            const heading = t('feedbackTree.confirmMuteTitle');
            return (
                <FeedbackHubLevel
                    heading={heading}
                    subtitle={
                        site
                            ? t('feedbackTree.confirmMuteBody', { publication: site })
                            : t('feedbackTree.confirmMuteBodyUnnamed')
                    }
                    rows={[
                        {
                            key: level.node.id,
                            testID: 'tree-confirm-destructive',
                            label: label(level.node),
                            icon: 'block',
                            destructive: true,
                            onPress: () => void answerLeaf(level.node, level.pathIds),
                        },
                        tellRow('feedbackTree.menu.tellTrust', heading),
                    ]}
                />
            );
        }
        const { nodes, hasVisibleChildren } = resolveTreeLevel(tree, level.pathIds, context);
        const rows = nodes.map((n) => nodeRow(n, level.pathIds, hasVisibleChildren(n)));
        if (level.pathIds.length > 0) {
            const meta = HEADINGS[level.pathIds[level.pathIds.length - 1]];
            const vars = { fact: feedbackLabelVars(context).fact, site };
            const heading = meta ? t(meta.key, vars) : '';
            return (
                <FeedbackHubLevel
                    heading={heading}
                    rows={[...rows, tellRow(meta?.tell ?? 'feedbackTree.menu.tellRoot', heading)]}
                />
            );
        }
        // The root: answered rows show a ✓ and their answer.
        const answered = answers.length > 0;
        const heading = t(answered ? 'feedbackTree.menu.again' : 'feedbackTree.menu.title');
        const rootRows = rows.map((row) => {
            const last = [...answers].reverse().find((a) => a.rootId === row.key);
            if (!last) return row;
            const answer = last.sent ? t('feedbackTree.menu.answerSent', { answer: last.answer }) : last.answer;
            return {
                ...row,
                answered: true,
                subtitle: answer,
                a11yLabel: t('feedbackTree.menu.answerA11y', { row: row.a11yLabel ?? row.label, answer }),
            };
        });
        const unsentMistake = answers.some((a) => a.cause === 'system' && !a.sent);
        if (unsentMistake && SENTRY_ENABLED) {
            rootRows.push({
                key: 'also-tell',
                testID: 'feedback-also-tell',
                label: t('feedbackTree.menu.alsoTell'),
                icon: 'bug-report',
                opensLevel: true,
                onPress: reportToLabs,
            });
        }
        rootRows.push(tellRow('feedbackTree.menu.tellRoot', heading));
        return (
            <FeedbackHubLevel
                heading={heading}
                subtitle={
                    answered
                        ? t('feedbackTree.menu.pickAnother')
                        : fact
                          ? t('feedbackTree.menu.factSubtitle', { fact: fact.statement })
                          : undefined
                }
                rows={rootRows}
                focusKey={focusKey}
            />
        );
    };

    return {
        answered: answers.length > 0,
        element: pickerElement,
        renderLevel,
        leavePlace,
        onSheetGone,
        reset,
    };
}
