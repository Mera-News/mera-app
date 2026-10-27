import ActionSheet, { ActionSheetRow, type ArticleMenuItem } from '@/components/custom/cards/ArticleOverflowMenu';
import FeedbackTreeLevel from '@/components/custom/feedback-tree/FeedbackTreeLevel';
import { feedbackNodeLabel, type FeedbackLabelContext } from '@/components/custom/feedback-tree/label-vars';
import { leafNeedsConfirm, performFeedbackLeaf } from '@/components/custom/feedback-tree/perform-feedback-leaf';
import type { FeedbackTree, FeedbackTreeNode, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree/types';
import type { FeedbackAnswersHandoff } from '@/lib/news-harness/core/types';
import type { VisitInput } from '@/components/custom/cards/article-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import type { InlineAccessibilityAction } from '@/components/custom/cards/use-article-actions';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import { Text } from '@/components/ui/text';
import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { FAQ_URL } from '@/lib/config/branding';
import { showFeedback } from '@/lib/feedback';
import { useColors } from '@/lib/theme/tokens';
import { router } from 'expo-router';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type AccessibilityActionEvent } from 'react-native';

/** If the Modal never reports its dismissal, run the picked item anyway after
 *  this long. A safety net only: the real signal is the dismissal itself. */
const MENU_DISMISS_FALLBACK_MS = 1200;

export interface UseArticleMenuInput {
    /** The article the actions are about. */
    subject: FeedbackSubject;
    /** The publication fallback when the subject names none. */
    visit?: VisitInput;
    /** The publisher id when the surface has one (GraphQL articles). Without
     *  it the publication page is opened by name plus `subject.countryCode`. */
    publisherId?: string | null;
    /** Starts a fact check. Omitted: the item is not offered. */
    onCheckFacts?: () => void | boolean | Promise<void | boolean>;
    /** Surface-specific items (e.g. "Not part of this story"), on the main
     *  level after Follow. */
    extraItems?: readonly ArticleMenuItem[];
    /** The surface's own inline buttons (see `inlineAccessibilityActions`),
     *  listed FIRST in the card's VoiceOver custom actions. The card root is one
     *  accessibility element, so the buttons drawn inside it are otherwise
     *  unreachable with VoiceOver. */
    inlineActions?: readonly InlineAccessibilityAction[];
    /** COMPACT rows only: they draw no inline action row (owner review), so
     *  "What's wrong with this story?", save and share lead the menu instead.
     *  Surfaces with an inline row (Feed card, detail) leave this out. */
    rowActions?: {
        /** The reader has answered the feedback sheet for this article: the
         *  item shows the filled glyph. */
        answered: boolean;
        saved: boolean;
        onToggleSave: () => void;
        /** Undefined when there is nothing to share. */
        onShare?: () => void;
    };
    /** The sheet recorded this article's verdict (on the reader's FIRST
     *  answer, never on open): the host fills its feedback icon. The row
     *  itself is written here. */
    onVerdictRecorded?: () => void;
    /** The subject the verdict row is written with, when the host resolves a
     *  richer one than `subject` (the detail screen). */
    resolveVerdictSubject?: () => Promise<FeedbackSubject>;
    /** Replaces the generic chat hand-off for Tell Mera. The Feed card and the
     *  detail screen pass theirs (`openFeedbackChatWithPath`). Runs after the
     *  sheet has gone. */
    onFeedbackChat?: (pathIds: string[], answers: FeedbackAnswersHandoff) => void;
    /** Replaces the card-level tree context (`buildOverlayContext(subject)`)
     *  for a host that resolves a richer subject itself (the detail screen). */
    resolveTreeContext?: () => Promise<LocalFeedbackContext>;
    /** Keep the follow state live even while the sheet is closed (a surface
     *  that draws its own Follow state inline). */
    followLive?: boolean;
}

/** A level's own heading and explanation (the confirm and follow levels),
 *  in the sheet's muted text, above its rows. */
const SheetNote: React.FC<{ title: string; body?: string }> = ({ title, body }) => {
    const colors = useColors();
    return (
        <VStack space="xs" className="px-4 pb-2" testID="sheet-note">
            <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>{title}</Text>
            {body ? (
                <Text size="sm" style={{ color: colors.ink3 }}>
                    {body}
                </Text>
            ) : null}
        </VStack>
    );
};

/** One level of the sheet's navigation stack. */
type SheetLevel =
    | { kind: 'main' }
    | { kind: 'source' }
    | { kind: 'support' }
    | { kind: 'tree'; pathIds: string[] }
    | { kind: 'tree-confirm'; node: FeedbackTreeNode; pathIds: string[] }
    | { kind: 'follow-tracked' }
    | { kind: 'follow-locked' };

function levelKey(depth: number, l: SheetLevel): string {
    if (l.kind === 'tree') return `${depth}:tree:${l.pathIds.join('/')}`;
    if (l.kind === 'tree-confirm') return `${depth}:confirm:${l.node.id}`;
    return `${depth}:${l.kind}`;
}

export interface UseArticleMenu {
    open: () => void;
    /** Open the sheet straight at the feedback root (no Back row): the inline
     *  feedback button outside the ••• menu. Records nothing by itself. */
    openFeedback: () => void;
    /** What an inline Follow button does: start the proposal flow, or open
     *  the sheet at the "already following" / free-tier level. */
    openFollow: () => void;
    /** Whether a story already covers this subject. */
    tracked: boolean;
    /** Open the publication page directly (a card's publication name). The
     *  ••• "About this source" item opens the same page after the sheet has
     *  closed. A no-op when the article names no publication. */
    openPublication: () => void;
    /** Mount once near the surface root: the sheet. */
    element: React.ReactNode;
    /** The same actions as VoiceOver custom actions, for the card root. */
    accessibilityActions: { name: string; label: string }[];
    onAccessibilityAction: (e: AccessibilityActionEvent) => void;
}

/** Live chat is offered only where Intercom is configured. Read once, at
 *  call time: lib/intercom loads a native SDK, and this hook sits under every
 *  card. */
let liveChatOn: boolean | null = null;
/** Main-level rows that open a level: not actions themselves. */
const LEVEL_SOURCE = 'level-source';
const LEVEL_SUPPORT = 'level-support';
function liveChatEnabled(): boolean {
    if (liveChatOn === null) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        liveChatOn = (require('@/lib/intercom') as typeof import('@/lib/intercom')).isIntercomEnabled();
    }
    return liveChatOn;
}

/**
 * ONE source of the ••• menu's items for every article surface (D3). Each
 * surface keeps its four inline actions (like, not for me, save, share) and
 * puts everything else here, so a new action is added once and appears
 * everywhere.
 *
 * The main level (FinalRead #14): [compact rows: Like, Not for me, Save,
 * Share], Fact check, Follow this story, the surface's extra items, then two
 * rows that open their own level: the publisher (About, Fewer from) and
 * Support (Report a bug, Live chat, FAQ, Tutorial). Open on source, Google
 * Translate and Ask Mera are not here: the article page and its Mera button
 * do them. The card's VoiceOver custom actions are every LEAF of every level,
 * so moving an item into a level never takes it away from VoiceOver.
 *
 * Every item runs AFTER the sheet has fully gone (BottomSheet `onClosed`),
 * with a MENU_DISMISS_FALLBACK_MS fallback and a flush on unmount, exactly
 * once. Never on a timer guess: iOS silently drops native UI presented while
 * a Modal is dismissing (the FAQ browser, Intercom, the feedback form), and
 * the await never resolves, so the item did nothing and said nothing. A failed
 * item says so with a retry.
 *
 * Report a bug NEVER attaches the article's id or URL: that would be a record
 * of which article this user read, which invariant 9 rules out.
 */
export function useArticleMenu(input: UseArticleMenuInput): UseArticleMenu {
    // The app language from i18n, which the language store keeps in step. Read
    // here rather than through the store hook: that store pulls the settings
    // service (and the database) into every card's import graph.
    const { t } = useTranslation();
    const toast = useToast();
    const [visible, setVisible] = useState(false);
    // The follow state is read only once the menu has been opened (or a
    // VoiceOver action used): a DB read per mounted card, just to label an item
    // nobody has looked at, is waste. It stays live after that, because items
    // run after the sheet has closed.
    const [engaged, setEngaged] = useState(false);
    const {
        subject,
        visit,
        publisherId,
        onCheckFacts,
        extraItems,
        inlineActions,
        rowActions,
        onFeedbackChat,
        followLive,
    } = input;
    const onVerdictRecordedRef = useRef(input.onVerdictRecorded);
    onVerdictRecordedRef.current = input.onVerdictRecorded;
    const resolveVerdictSubjectRef = useRef(input.resolveVerdictSubject);
    resolveVerdictSubjectRef.current = input.resolveVerdictSubject;
    const resolveTreeContextRef = useRef(input.resolveTreeContext);
    resolveTreeContextRef.current = input.resolveTreeContext;
    const follow = useTrackButton(subject, engaged || !!followLive);
    const { tracked } = follow;
    // The publication's raw name is the KEY: "Fewer from" writes it and every
    // filter matches on it. Its display name (in the app language) is only
    // what the rows and the toast SAY.
    const publication = (subject.publicationName ?? visit?.publicationName ?? '').trim();
    const publicationShown = useDisplayPublication(publication);
    const publicationCountry = subject.countryCode ?? visit?.countryCode ?? null;
    const openPublication = useCallback(() => {
        if (!publication && !publisherId) return;
        openPublicationPage({ publisherId: publisherId ?? null, rawName: publication, countryCode: publicationCountry });
    }, [publication, publisherId, publicationCountry]);

    // ── The sheet and its navigation stack ─────────────────────────────────
    // A sub-menu (the feedback tree, its confirm, the follow levels) is a LEVEL
    // pushed inside the one sheet, never a second Modal. Back pops one level;
    // Cancel closes the whole sheet from any depth.
    const [stack, setStack] = useState<SheetLevel[]>([]);
    const [direction, setDirection] = useState<'push' | 'pop' | 'none'>('none');
    const [mounted, setMounted] = useState(false);
    const visibleRef = useRef(false);
    visibleRef.current = visible;
    const [treeContext, setTreeContext] = useState<LocalFeedbackContext>({ articleTitle: subject.title });

    /** Show a level: pushed on top when the sheet is open, else the sheet opens
     *  straight at it (no Back row). */
    const showLevel = useCallback((level: SheetLevel) => {
        setEngaged(true);
        if (visibleRef.current) {
            setDirection('push');
            setStack((s) => [...s, level]);
            return;
        }
        setDirection('none');
        setStack([level]);
        setMounted(true);
        setVisible(true);
    }, []);
    const back = useCallback(() => {
        setDirection('pop');
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    }, []);

    // The tree AND its gating context are resolved BEFORE a tree level is
    // pushed, so the level lands with its final rows. Pushing first and
    // resolving after drew one row, then grew the sheet ~1.2s later when the
    // context let the gated branches through (batch 12). Prefetched the moment
    // the sheet opens, so a Like tap normally pushes at once.
    const [tree, setTree] = useState<FeedbackTree | null>(null);
    const prepRef = useRef<{ articleId: string; promise: Promise<void>; done: boolean } | null>(null);
    const prepareTree = useCallback((): { promise: Promise<void>; done: boolean } => {
        if (prepRef.current && prepRef.current.articleId === subject.articleId) return prepRef.current;
        const entry = { articleId: subject.articleId, done: false, promise: Promise.resolve() };
        entry.promise = (async () => {
            // Resolved at call time: both reach storage or the database, and
            // this hook sits under every card.
            /* eslint-disable @typescript-eslint/no-require-imports */
            const { getFeedbackTree, refreshFeedbackTree } = require('@/lib/services/feedback-tree-service') as typeof import('@/lib/services/feedback-tree-service');
            const { buildOverlayContext } = require('@/components/custom/cards/overlay-context') as typeof import('@/components/custom/cards/overlay-context');
            /* eslint-enable @typescript-eslint/no-require-imports */
            // This sheet is the only surface that shows the tree, so it is also
            // what keeps the cached server tree fresh. Throttled (~24h) in the
            // service; errors and offline are swallowed there.
            void refreshFeedbackTree();
            const resolveHost = resolveTreeContextRef.current;
            const [tr, ctx] = await Promise.all([
                getFeedbackTree(),
                (resolveHost ? resolveHost() : buildOverlayContext(subject)).catch(
                    () => ({ articleTitle: subject.title }) as LocalFeedbackContext,
                ),
            ]);
            setTree(tr);
            setTreeContext(ctx);
            entry.done = true;
        })().catch(() => {
            entry.done = false;
            prepRef.current = null;
        });
        prepRef.current = entry;
        return entry;
    }, [subject]);

    const enterTree = useCallback(
        () => {
            const level: SheetLevel = { kind: 'tree', pathIds: [] };
            const prep = prepareTree();
            if (prep.done) showLevel(level);
            else void prep.promise.then(() => showLevel(level));
        },
        [prepareTree, showLevel],
    );

    const showFailure = useCallback(
        (retry: () => void) => {
            toast.show({
                duration: 5000,
                render: ({ id }: { id: string }) => (
                    <MeraToast
                        tone="error"
                        title={t('articleMenu.actionFailed')}
                        actions={[
                            {
                                label: t('common.retry'),
                                testID: 'article-menu-retry',
                                onPress: () => {
                                    toast.close(id);
                                    retry();
                                },
                            },
                        ]}
                    />
                ),
            });
        },
        [toast, t],
    );

    const runItem = useCallback(
        (item: ArticleMenuItem) => {
            const attempt = async () => {
                let ok: void | boolean = undefined;
                try {
                    ok = await item.run();
                } catch {
                    ok = false;
                }
                if (ok === false) showFailure(() => void attempt());
            };
            void attempt();
        },
        [showFailure],
    );

    const fewerFromSource = useCallback(
        async (publicationName: string, shownAs: string): Promise<boolean> => {
            // Resolved at call time: the preference writer pulls in the persona
            // executor and the database, and this hook sits under every card.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { setSourcePrefFromUi, revertSourcePrefChange } = require('@/lib/database/services/publication-pref-ui-actions') as typeof import('@/lib/database/services/publication-pref-ui-actions');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { resolvePublicationPrefNames } = require('@/lib/database/services/publisher-source-names') as typeof import('@/lib/database/services/publisher-source-names');
            // EVERY name the publication is known by: scoring matches a
            // preference by source name, and a publication's sources are not
            // all named alike. One press can therefore write several rows.
            const names = await resolvePublicationPrefNames({ publisherId, rawName: publicationName });
            const res = await setSourcePrefFromUi({ kind: 'publisher', names }, 'deprioritised');
            if (!res.applied) return false;
            // The app's one undo toast. Required at call time, like the writer.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
            toastManager.showUndoToast({
                title: t('articleMenu.fewerFromDone', { source: shownAs }),
                undoLabel: t('articleMenu.undo'),
                undoTestID: 'article-menu-undo',
                // The same "Change undone" the leaf's undo shows; the manager
                // skips it when the revert was refused (onUndo → false).
                undoneTitle: t('feedbackTree.undoneTitle'),
                // Reverts EVERY row this press wrote, each compare-and-set: if a
                // newer change owns a name's value, that row is left alone and
                // the toast claims nothing for it. A fresh 'none' write
                // clobbered a later boost and logged as a new action (batch 16).
                onUndo: () => revertSourcePrefChange(res),
            });
            return true;
        },
        [t, publisherId],
    );

    const items = useMemo<ArticleMenuItem[]>(() => {
        const list: ArticleMenuItem[] = [];
        if (rowActions) {
            list.push(
                {
                    key: 'whats-wrong',
                    label: t('feedbackTree.menu.title'),
                    icon: rowActions.answered ? 'feedback' : 'chat-bubble-outline',
                    testID: 'menu-whats-wrong',
                    staysOpen: true,
                    opensLevel: true,
                    run: () => enterTree(),
                },
                {
                    key: 'save',
                    label: t(rowActions.saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction'),
                    icon: rowActions.saved ? 'bookmark' : 'bookmark-border',
                    testID: 'menu-save',
                    run: () => rowActions.onToggleSave(),
                },
            );
            const share = rowActions.onShare;
            if (share) {
                list.push({
                    key: 'share',
                    label: t('articleDetail.share'),
                    icon: Platform.OS === 'ios' ? 'ios-share' : 'share',
                    testID: 'menu-share',
                    run: () => share(),
                });
            }
        }
        if (onCheckFacts) {
            list.push({
                key: 'check-facts',
                label: t('articleMenu.checkFacts'),
                icon: 'fact-check',
                testID: 'card-action-fact-check',
                run: onCheckFacts,
            });
        }
        list.push({
            key: 'follow',
            label: tracked ? t('articleMenu.following') : t('feedbackTree.followStory'),
            icon: 'track-changes',
            testID: 'card-action-track',
            staysOpen: true,
            run: () => openFollowRef.current(),
        });
        if (extraItems) list.push(...extraItems);
        if (publication || publisherId) {
            list.push({
                key: LEVEL_SOURCE,
                label: publicationShown || publication,
                subtitle: t('articleMenu.sourceSub', { source: publicationShown || publication }),
                icon: 'article',
                testID: 'menu-source',
                staysOpen: true,
                opensLevel: true,
                run: () => showLevel({ kind: 'source' }),
            });
        }
        list.push({
            key: LEVEL_SUPPORT,
            label: t('articleMenu.support'),
            subtitle: t('articleMenu.supportSub'),
            icon: 'help-outline',
            testID: 'menu-support',
            staysOpen: true,
            opensLevel: true,
            run: () => showLevel({ kind: 'support' }),
        });
        return list;
    }, [t, publication, publicationShown, tracked, enterTree, onCheckFacts, publisherId, extraItems, rowActions, showLevel]);

    /** The publisher's level: About this source, Fewer from. */
    const sourceItems = useMemo<ArticleMenuItem[]>(() => {
        const list: ArticleMenuItem[] = [];
        if (publication || publisherId) {
            list.push({
                key: 'about-source',
                label: t('articleMenu.aboutSource'),
                // The card's VoiceOver/TalkBack action names the source.
                a11yLabel: t('publicationPage.aboutSourceA11y', { source: publicationShown || publication }),
                icon: 'info-outline',
                testID: 'menu-about-source',
                // Runs after the sheet has gone, like every closing item.
                run: openPublication,
            });
        }
        if (publication) {
            list.push({
                key: 'fewer-from',
                label: t('articleMenu.fewerFrom', { source: publicationShown }),
                icon: 'trending-down',
                testID: 'menu-fewer-from-source',
                run: () => fewerFromSource(publication, publicationShown),
            });
        }
        return list;
    }, [t, publication, publicationShown, publisherId, openPublication, fewerFromSource]);

    /** Support: report a bug, a person from the Mera team, the FAQ, the
     *  tutorial. Each presents native UI or navigates, so each runs after the
     *  sheet has gone. */
    const supportItems = useMemo<ArticleMenuItem[]>(() => {
        const list: ArticleMenuItem[] = [];
        if (SENTRY_ENABLED) {
            list.push({
                key: 'report-bug',
                label: t('articleMenu.reportBug'),
                icon: 'bug-report',
                testID: 'menu-report-bug',
                // No article context: see this hook's header.
                run: () => showFeedback(),
            });
        }
        if (liveChatEnabled()) {
            list.push({
                key: 'live-chat',
                label: t('articleMenu.liveChat'),
                subtitle: t('articleMenu.liveChatSub'),
                icon: 'chat-bubble-outline',
                testID: 'menu-live-chat',
                run: () =>
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    (require('@/lib/intercom') as typeof import('@/lib/intercom')).presentIntercomMessenger(),
            });
        }
        list.push(
            {
                key: 'faq',
                label: t('preferences.faq'),
                icon: 'quiz',
                testID: 'menu-faq',
                run: async () => {
                    // Required at call time: it reads the language store.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { openInAppBrowser, withAppLanguage } = require('@/lib/web-browser-utils') as typeof import('@/lib/web-browser-utils');
                    await openInAppBrowser(withAppLanguage(FAQ_URL));
                },
            },
            {
                key: 'tutorial',
                label: t('articleMenu.tutorial'),
                icon: 'school',
                testID: 'menu-tutorial',
                run: () => router.push('/tutorials'),
            },
        );
        return list;
    }, [t]);

    // The sheet stays mounted while its Modal dismisses; `pending` holds the
    // picked item until the dismissal is reported. See the header.
    const pendingRef = useRef<ArticleMenuItem | null>(null);
    const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const runItemRef = useRef(runItem);
    runItemRef.current = runItem;

    /** Runs the pending item, if any, exactly once. */
    const flushPending = useCallback(() => {
        if (fallbackRef.current) {
            clearTimeout(fallbackRef.current);
            fallbackRef.current = null;
        }
        const item = pendingRef.current;
        pendingRef.current = null;
        if (item) runItemRef.current(item);
    }, []);

    // The Modal reports it is gone. Take the sheet OUT of the tree first and
    // run the item one frame after that commit: an item that presents another
    // RN Modal (the feedback tree behind Like / Not for me) is refused by iOS
    // while the menu's Modal host is still mounted, and nothing reports it.
    const runAfterUnmountRef = useRef(false);
    const onDismissed = useCallback(() => {
        if (fallbackRef.current) {
            clearTimeout(fallbackRef.current);
            fallbackRef.current = null;
        }
        runAfterUnmountRef.current = true;
        setMounted(false);
        setStack([]);
    }, []);
    useEffect(() => {
        if (mounted || !runAfterUnmountRef.current) return;
        runAfterUnmountRef.current = false;
        requestAnimationFrame(() => flushPending());
    }, [mounted, flushPending]);

    const close = useCallback(() => setVisible(false), []);
    /** Close the sheet, then run `after` once it has gone (native UI, a
     *  screen push, a chat, a toast). */
    const closeThen = useCallback(
        (after?: () => void) => {
            pendingRef.current = after ? { key: 'after', label: '', icon: null, testID: '', run: after } : null;
            setVisible(false);
            if (fallbackRef.current) clearTimeout(fallbackRef.current);
            fallbackRef.current = setTimeout(onDismissed, MENU_DISMISS_FALLBACK_MS);
        },
        [onDismissed],
    );
    const closeRef = useRef<() => void>(() => {});
    closeRef.current = () => closeThen();
    const pick = useCallback(
        (item: ArticleMenuItem) => {
            // An item that navigates within the sheet runs now; any other runs
            // after the sheet has gone.
            if (item.staysOpen) {
                runItem(item);
                return;
            }
            closeThen(() => runItem(item));
        },
        [closeThen, runItem],
    );

    const openFollow = useCallback(() => {
        const outcome = follow.resolve();
        if (outcome === 'tracked') showLevel({ kind: 'follow-tracked' });
        else if (outcome === 'locked') showLevel({ kind: 'follow-locked' });
        else if (visibleRef.current) closeThen(follow.startTracking);
        else follow.startTracking();
    }, [follow, showLevel, closeThen]);
    const openFollowRef = useRef(openFollow);
    openFollowRef.current = openFollow;


    // A host that unmounts mid-dismissal (the row scrolled away, the screen
    // closed) still runs what the reader picked, once.
    useEffect(() => () => flushPending(), [flushPending]);

    // Every LEAF of every level, so an item moved into a level stays a
    // VoiceOver custom action on the card.
    const leaves = useMemo(
        () => [...items.filter((i) => i.key !== LEVEL_SOURCE && i.key !== LEVEL_SUPPORT), ...sourceItems, ...supportItems],
        [items, sourceItems, supportItems],
    );
    const accessibilityActions = useMemo(
        () => [
            ...(inlineActions ?? []).map((i) => ({ name: `inline-${i.key}`, label: i.label })),
            ...leaves.map((i) => ({ name: i.key, label: i.a11yLabel ?? i.label })),
        ],
        [leaves, inlineActions],
    );
    const onAccessibilityAction = useCallback(
        (e: AccessibilityActionEvent) => {
            const name = e.nativeEvent.actionName;
            const inline = inlineActions?.find((i) => `inline-${i.key}` === name);
            if (inline) {
                inline.run();
                return;
            }
            setEngaged(true);
            const item = leaves.find((i) => i.key === name);
            if (item) runItem(item);
        },
        [leaves, runItem, inlineActions],
    );

    // ── The levels ─────────────────────────────────────────────────────────
    const chrome = useCallback(
        (key: string, def: string, vars?: Record<string, unknown>) =>
            t(`feedbackTree.${key}`, { defaultValue: def, ...vars }) as string,
        [t],
    );
    const showInfo = useCallback(
        (title: string, body?: string) => {
            toast.show({
                duration: 2500,
                render: () => (
                    <MeraToast tone="info" title={title} body={body} />
                ),
            });
        },
        [toast],
    );
    // What the tree's rows SAY: the context plus the publication's display
    // name for {{publication}}. The leaf actions keep `treeContext`, whose
    // `publicationName` stays the raw key a publication filter matches on.
    const treePublicationShown = useDisplayPublication(treeContext.publicationName ?? '');
    const labelContext = useMemo<FeedbackLabelContext>(
        () => ({ ...treeContext, publicationDisplayName: treePublicationShown || null }),
        [treeContext, treePublicationShown],
    );
    // The Undo toast names the leaf exactly as its row did (vars filled).
    const treeLabel = useCallback(
        (node: FeedbackTreeNode) => feedbackNodeLabel(t, node, labelContext),
        [t, labelContext],
    );
    // The verdict row is written on the reader's FIRST answer, never on open
    // (owner): Done with no answer changes nothing. Idempotent per article, so
    // a second answer, or a sheet opened again, reuses the row.
    const verdictRef = useRef<{ articleId: string; promise: Promise<void> } | null>(null);
    const ensureVerdict = useCallback((): Promise<void> => {
        if (verdictRef.current?.articleId === subject.articleId) return verdictRef.current.promise;
        const promise = (async () => {
            // Required at call time: the service reaches the database, and this
            // hook sits under every card.
            /* eslint-disable @typescript-eslint/no-require-imports */
            const { recordVerdictFeedback } = require('@/lib/database/services/article-feedback-service') as typeof import('@/lib/database/services/article-feedback-service');
            const { buildContextJson } = require('@/components/custom/cards/feedback-subject') as typeof import('@/components/custom/cards/feedback-subject');
            /* eslint-enable @typescript-eslint/no-require-imports */
            const resolve = resolveVerdictSubjectRef.current;
            const s = resolve ? await resolve().catch(() => subject) : subject;
            await recordVerdictFeedback({
                articleId: s.articleId,
                suggestionId: s.suggestionId,
                sentiment: 'dislike',
                title: s.title,
                origin: s.origin,
                surface: s.surface,
                contextJson: buildContextJson(s),
            });
            onVerdictRecordedRef.current?.();
        })();
        verdictRef.current = { articleId: subject.articleId, promise };
        return promise;
    }, [subject]);
    // A leaf settled: its path on the verdict row. ORDER MATTERS: a committed
    // path write re-opens the row for the digest, and it lands after
    // applyLeafActions stamped it spent, so re-stamp when something applied.
    const persistLeaf = useCallback(
        (pathIds: string[], applied: number, committed: boolean) => {
            void (async () => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const svc = require('@/lib/database/services/article-feedback-service') as typeof import('@/lib/database/services/article-feedback-service');
                await svc.updateFeedbackContextPath(subject.articleId, 'dislike', pathIds, committed);
                if (applied > 0) await svc.markFeedbackProcessedFor(subject.articleId, 'dislike');
            })();
        },
        [subject.articleId],
    );
    const performLeaf = useCallback(
        (node: FeedbackTreeNode, pathIds: string[]) => {
            void ensureVerdict().then(() =>
                performFeedbackLeaf(node, pathIds, {
                    context: treeContext,
                    chatContext: {
                        kind: 'article-suggestion',
                        articleId: subject.articleId,
                        suggestionId: subject.suggestionId,
                        articleTitle: subject.title,
                    },
                    chatMessage: t('articleFeedback.thumbsDownMessage', { title: subject.title }),
                    label: treeLabel(node),
                    spend: { articleId: subject.articleId, sentiment: 'dislike' },
                    openChat: onFeedbackChat
                        ? () =>
                              onFeedbackChat(pathIds, {
                                  answers: [{ cause: node.leaf?.cause ?? 'config', question: treeLabel(node) }],
                                  screen: t('feedbackTree.menu.title'),
                                  ...(treeContext.fact ? { fact: treeContext.fact.statement } : {}),
                              })
                        : undefined,
                    closeThen,
                    onLeafPicked: persistLeaf,
                    showInfo,
                    chrome,
                }),
            );
        },
        [ensureVerdict, treeContext, subject, t, treeLabel, closeThen, persistLeaf, onFeedbackChat, showInfo, chrome],
    );

    const top = stack[stack.length - 1];
    const rows = (list: ArticleMenuItem[]) =>
        list.map((item) => (
            <ActionSheetRow
                key={item.key}
                testID={item.testID}
                label={item.label}
                subtitle={item.subtitle}
                icon={item.icon}
                opensLevel={item.opensLevel}
                onPress={() => pick(item)}
            />
        ));
    const renderLevel = (level: SheetLevel): React.ReactNode => {
        switch (level.kind) {
            case 'main':
                return rows(items);
            case 'source':
                return rows(sourceItems);
            case 'support':
                return rows(supportItems);
            case 'tree':
                return tree ? (
                    <FeedbackTreeLevel
                        tree={tree}
                        pathIds={level.pathIds}
                        context={labelContext}
                        onDescend={(node) =>
                            showLevel({ ...level, pathIds: [...level.pathIds, node.id] })
                        }
                        onLeaf={(node, pathIds) =>
                            leafNeedsConfirm(node)
                                ? showLevel({ kind: 'tree-confirm', node, pathIds })
                                : performLeaf(node, pathIds)
                        }
                    />
                ) : null;
            case 'tree-confirm':
                return (
                    <>
                        <SheetNote
                            title={chrome('confirmMuteTitle', 'Never show this publication?')}
                            // Unnamed: its own whole sentence, never an English
                            // phrase spliced into a translated one.
                            body={
                                treePublicationShown
                                    ? chrome(
                                          'confirmMuteBody',
                                          "You won't see articles from {{publication}} again. You can undo this anytime.",
                                          { publication: treePublicationShown },
                                      )
                                    : chrome(
                                          'confirmMuteBodyUnnamed',
                                          "You won't see articles from this publication again. You can undo this anytime.",
                                      )
                            }
                        />
                        <ActionSheetRow
                            testID="tree-confirm-destructive"
                            label={treeLabel(level.node)}
                            icon="block"
                            destructive
                            onPress={() => performLeaf(level.node, level.pathIds)}
                        />
                    </>
                );
            case 'follow-tracked':
                return (
                    <>
                        <SheetNote
                            title={t('trackedStories.alreadyTrackingTitle')}
                            body={t('trackedStories.alreadyTrackingBody')}
                        />
                        <ActionSheetRow
                            testID="already-tracking-go"
                            label={t('trackedStories.goToStoryAction')}
                            icon="open-in-new"
                            onPress={() => closeThen(follow.goToStory)}
                        />
                    </>
                );
            case 'follow-locked':
                return (
                    <>
                        <SheetNote title={t('freeTier.trackTitle')} body={t('freeTier.trackBody')} />
                        <ActionSheetRow
                            testID="track-locked-see-plans"
                            label={t('freeTier.seePlans')}
                            icon="workspace-premium"
                            onPress={() => closeThen(() => void follow.seePlans())}
                        />
                    </>
                );
        }
    };

    const element = (
        <ActionSheet
            mounted={mounted}
            visible={visible}
            onDismiss={Platform.OS === 'ios' ? onDismissed : undefined}
            // Android has no `onDismiss`: the sheet has gone once its slide-down
            // finishes and the Modal is hidden.
            onExited={Platform.OS === 'ios' ? undefined : onDismissed}
            onClose={close}
            levelKey={top ? levelKey(stack.length, top) : 'none'}
            direction={direction}
            onBack={stack.length > 1 ? back : undefined}
        >
            {top ? renderLevel(top) : null}
        </ActionSheet>
    );

    return {
        open: useCallback(() => {
            setEngaged(true);
            prepareTree();
            setDirection('none');
            setStack([{ kind: 'main' }]);
            setMounted(true);
            setVisible(true);
        }, [prepareTree]),
        openFeedback: enterTree,
        openFollow,
        tracked,
        openPublication,
        element,
        accessibilityActions,
        onAccessibilityAction,
    };
}
