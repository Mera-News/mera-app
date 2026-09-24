import ActionSheet, { ActionSheetRow, type ArticleMenuItem } from '@/components/custom/cards/ArticleOverflowMenu';
import FeedbackTreeLevel from '@/components/custom/feedback-tree/FeedbackTreeLevel';
import { feedbackNodeLabel } from '@/components/custom/feedback-tree/label-vars';
import { leafNeedsConfirm, performFeedbackLeaf } from '@/components/custom/feedback-tree/perform-feedback-leaf';
import type { FeedbackTree, FeedbackTreeNode, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { VerdictSentiment } from '@/lib/database/services/article-feedback-service';
import {
    isForeignLanguage,
    openInGoogleTranslate,
    openOnSource,
    type VisitInput,
} from '@/components/custom/cards/article-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import type { InlineAccessibilityAction } from '@/components/custom/cards/use-article-actions';
import { askMeraAbout } from '@/components/custom/floating-chat/ask-mera';
import MeraLogo from '@/components/custom/MeraLogo';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { showFeedback } from '@/lib/feedback';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, type AccessibilityActionEvent } from 'react-native';

/** If the Modal never reports its dismissal, run the picked item anyway after
 *  this long. A safety net only: the real signal is the dismissal itself. */
export const MENU_DISMISS_FALLBACK_MS = 1200;

export type ArticleMenuSurface = 'card' | 'detail';

export interface UseArticleMenuInput {
    /** Where the menu opens from. On `detail`, "Open on source" is omitted: it
     *  is the screen's primary call to action already. */
    surface: ArticleMenuSurface;
    /** The article the actions are about. */
    subject: FeedbackSubject;
    /** Raw publisher URL (the https guard is applied at open time). */
    articleUrl?: string | null;
    /** The article's own language, for the Google Translate item. */
    languageCode?: string | null;
    /** What a publisher visit records ("Open on source" backs History). */
    visit?: VisitInput;
    /** Starts a fact check. Omitted: the item is not offered. */
    onCheckFacts?: () => void | boolean | Promise<void | boolean>;
    /** Surface-specific items (e.g. "Not part of this story"), listed before
     *  "Report a bug". */
    extraItems?: readonly ArticleMenuItem[];
    /** The surface's own inline buttons (see `inlineAccessibilityActions`),
     *  listed FIRST in the card's VoiceOver custom actions. The card root is one
     *  accessibility element, so the buttons drawn inside it are otherwise
     *  unreachable with VoiceOver. */
    inlineActions?: readonly InlineAccessibilityAction[];
    /** COMPACT rows only: they draw no inline action row (owner review), so
     *  like, not for me, save and share lead the menu instead. Surfaces with an
     *  inline row (Feed card, detail) leave this out. */
    rowActions?: {
        /** A like is recorded: the item shows the filled glyph and reads
         *  "Remove like"; a tap removes it. */
        liked: boolean;
        /** A dislike is recorded: "Remove not for me", filled glyph. Never
         *  true together with `liked` (latest wins). */
        disliked?: boolean;
        saved: boolean;
        onLike: () => void;
        onDislike: () => void;
        onToggleSave: () => void;
        /** Undefined when there is nothing to share. */
        onShare?: () => void;
    };
    /** A feedback-tree leaf settled (see useArticleActions.onLeafPicked). */
    onLeafPicked?: (sentiment: VerdictSentiment, pathIds: string[], appliedCount: number, committed: boolean) => void;
    /** Replaces the generic chat hand-off for an `openChat` tree leaf. The Feed
     *  card and the detail screen pass theirs, which carries the verdict and
     *  the tapped breadcrumb. Runs after the sheet has gone. */
    onFeedbackChat?: (sentiment: VerdictSentiment, pathIds: string[]) => void;
    /** Where the `browse_related` nudge goes (the Feed opens the detail
     *  screen, the detail screen scrolls to its related coverage). Runs after
     *  the sheet has gone. Omitted: a toast. */
    onBrowseRelated?: (sentiment: VerdictSentiment) => void;
    /** Replaces the card-level tree context (`buildOverlayContext(subject)`)
     *  for a host that resolves a richer subject itself (the detail screen). */
    resolveTreeContext?: () => Promise<LocalFeedbackContext>;
    /** Keep the follow state live even while the sheet is closed (a surface
     *  that draws its own Follow state inline). */
    followLive?: boolean;
}

/** A level's own heading and explanation (the confirm and follow levels),
 *  in the sheet's muted text, above its rows. */
const SheetNote: React.FC<{ title: string; body?: string }> = ({ title, body }) => (
    <VStack space="xs" className="px-4 pb-2" testID="sheet-note">
        <Text style={{ color: 'rgb(230,230,230)', fontSize: 15, fontWeight: '700' }}>{title}</Text>
        {body ? (
            <Text size="sm" style={{ color: 'rgb(163,163,163)' }}>
                {body}
            </Text>
        ) : null}
    </VStack>
);

/** One level of the sheet's navigation stack. */
export type SheetLevel =
    | { kind: 'main' }
    | { kind: 'tree'; root: VerdictSentiment; pathIds: string[] }
    | { kind: 'tree-confirm'; root: VerdictSentiment; node: FeedbackTreeNode; pathIds: string[] }
    | { kind: 'follow-tracked' }
    | { kind: 'follow-locked' };

function levelKey(depth: number, l: SheetLevel): string {
    if (l.kind === 'tree') return `${depth}:tree:${l.root}:${l.pathIds.join('/')}`;
    if (l.kind === 'tree-confirm') return `${depth}:confirm:${l.node.id}`;
    return `${depth}:${l.kind}`;
}

export interface UseArticleMenu {
    open: () => void;
    /** Open the sheet straight at a feedback tree's root (no Back row): an
     *  inline thumb outside the ••• menu. */
    openFeedback: (root: VerdictSentiment) => void;
    /** What an inline Follow button does: start the proposal flow, or open
     *  the sheet at the "already following" / free-tier level. */
    openFollow: () => void;
    /** Whether a story already covers this subject. */
    tracked: boolean;
    /** Mount once near the surface root: the sheet. */
    element: React.ReactNode;
    /** The same actions as VoiceOver custom actions, for the card root. */
    accessibilityActions: { name: string; label: string }[];
    onAccessibilityAction: (e: AccessibilityActionEvent) => void;
}

/**
 * ONE source of the ••• menu's items for every article surface (D3). Each
 * surface keeps its four inline actions (like, not for me, save, share) and
 * puts everything else here, so a new action is added once and appears
 * everywhere.
 *
 * Every item runs AFTER the sheet's Modal has finished dismissing: on
 * `onDismiss` on iOS, when the sheet's slide-down ends on Android (RN has no
 * `onDismiss` there), with a MENU_DISMISS_FALLBACK_MS fallback and a flush on
 * unmount, exactly once. Never on a timer guess: iOS silently drops native UI
 * presented while a Modal is dismissing (SFSafariViewController for "Open on
 * source" and Google Translate, the feedback form), and the await never
 * resolves, so the item did nothing and said nothing. A failed item says so
 * with a retry.
 *
 * Report a bug NEVER attaches the article's id or URL: that would be a record
 * of which article this user read, which invariant 9 rules out.
 */
export function useArticleMenu(input: UseArticleMenuInput): UseArticleMenu {
    // The app language from i18n, which the language store keeps in step. Read
    // here rather than through the store hook: that store pulls the settings
    // service (and the database) into every card's import graph.
    const { t, i18n } = useTranslation();
    const toast = useToast();
    const appLanguage = i18n?.language ?? 'en';
    const [visible, setVisible] = useState(false);
    // The follow state is read only once the menu has been opened (or a
    // VoiceOver action used): a DB read per mounted card, just to label an item
    // nobody has looked at, is waste. It stays live after that, because items
    // run after the sheet has closed.
    const [engaged, setEngaged] = useState(false);
    const {
        subject,
        surface,
        articleUrl,
        languageCode,
        visit,
        onCheckFacts,
        extraItems,
        inlineActions,
        rowActions,
        onLeafPicked,
        onFeedbackChat,
        onBrowseRelated,
        followLive,
    } = input;
    const resolveTreeContextRef = useRef(input.resolveTreeContext);
    resolveTreeContextRef.current = input.resolveTreeContext;
    const follow = useTrackButton(subject, engaged || !!followLive);
    const { tracked } = follow;

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
        (root: VerdictSentiment) => {
            const level: SheetLevel = { kind: 'tree', root, pathIds: [] };
            const prep = prepareTree();
            if (prep.done) showLevel(level);
            else void prep.promise.then(() => showLevel(level));
        },
        [prepareTree, showLevel],
    );

    const showFailure = useCallback(
        (retry: () => void) => {
            toast.show({
                placement: 'top',
                duration: 5000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="error" variant="solid">
                        <ToastTitle>{t('articleMenu.actionFailed')}</ToastTitle>
                        <Pressable
                            testID="article-menu-retry"
                            accessibilityRole="button"
                            accessibilityLabel={t('common.retry')}
                            hitSlop={12}
                            onPress={() => {
                                toast.close(id);
                                retry();
                            }}
                        >
                            <Text className="font-semibold text-white">{t('common.retry')}</Text>
                        </Pressable>
                    </Toast>
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
        async (publicationName: string): Promise<boolean> => {
            // Resolved at call time: the preference writer pulls in the persona
            // executor and the database, and this hook sits under every card.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { setSourcePrefFromUi } = require('@/lib/database/services/publication-pref-ui-actions') as typeof import('@/lib/database/services/publication-pref-ui-actions');
            const res = await setSourcePrefFromUi({ kind: 'publication', publicationName }, 'deprioritised');
            if (!res.applied) return false;
            // The app's one undo toast. Required at call time, like the writer.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
            toastManager.showUndoToast({
                title: t('articleMenu.fewerFromDone', { source: publicationName }),
                undoLabel: t('articleMenu.undo'),
                undoTestID: 'article-menu-undo',
                // Reverts THIS change (compare-and-set): if a newer change owns
                // the publication's value, nothing is written and the toast
                // claims nothing. A fresh 'none' write clobbered a later boost
                // and logged as a new action (batch 16).
                onUndo: async () => {
                    if (!res.changeLogId) return false;
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { revertChange } = require('@/lib/database/services/persona-change-log-service') as typeof import('@/lib/database/services/persona-change-log-service');
                    return revertChange(res.changeLogId);
                },
            });
            return true;
        },
        [t],
    );

    const items = useMemo<ArticleMenuItem[]>(() => {
        const list: ArticleMenuItem[] = [];
        if (rowActions) {
            list.push(
                {
                    key: 'like',
                    // Once liked the item says what a tap does now (it removes
                    // the like), instead of repeating "I like it".
                    label: rowActions.liked ? t('articleMenu.removeLike') : t('articleFeedback.likeLabel'),
                    icon: rowActions.liked ? 'thumb-up' : 'thumb-up-off-alt',
                    testID: 'menu-like',
                    staysOpen: true,
                    opensLevel: !rowActions.liked,
                    // Recording a like opens its tree as a level of this sheet.
                    // Removing one needs nothing more, so the sheet closes.
                    run: () => {
                        const wasLiked = rowActions.liked;
                        rowActions.onLike();
                        if (!wasLiked) enterTree('like');
                        else if (visibleRef.current) closeRef.current();
                    },
                },
                {
                    key: 'dislike',
                    // Mirrors Like: once disliked it says a tap removes it.
                    label: rowActions.disliked ? t('articleMenu.removeDislike') : t('articleFeedback.dislikeLabel'),
                    icon: rowActions.disliked ? 'thumb-down' : 'thumb-down-off-alt',
                    testID: 'menu-dislike',
                    staysOpen: true,
                    opensLevel: !rowActions.disliked,
                    run: () => {
                        const wasDisliked = !!rowActions.disliked;
                        rowActions.onDislike();
                        if (!wasDisliked) enterTree('dislike');
                        else if (visibleRef.current) closeRef.current();
                    },
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
        list.push({
            key: 'ask',
            label: t('articleMenu.askMera'),
            icon: <MeraLogo size={22} animated={false} />,
            testID: 'card-action-mera',
            run: () =>
                askMeraAbout({
                    articleId: subject.articleId,
                    suggestionId: subject.suggestionId,
                    title: subject.title,
                }),
        });
        list.push({
            key: 'follow',
            label: tracked ? t('articleMenu.following') : t('feedbackTree.followStory'),
            icon: 'track-changes',
            testID: 'card-action-track',
            staysOpen: true,
            run: () => openFollowRef.current(),
        });
        if (onCheckFacts) {
            list.push({
                key: 'check-facts',
                label: t('articleMenu.checkFacts'),
                icon: 'fact-check',
                testID: 'card-action-fact-check',
                run: onCheckFacts,
            });
        }
        const publication = (subject.publicationName ?? visit?.publicationName ?? '').trim();
        if (surface !== 'detail' && articleUrl) {
            list.push({
                key: 'open-source',
                label: publication
                    ? t('articleMenu.openOn', { source: publication })
                    : t('articleDetail.readArticle'),
                icon: 'open-in-new',
                testID: 'menu-open-source',
                run: () => openOnSource(articleUrl, visit),
            });
        }
        if (articleUrl && isForeignLanguage(languageCode, appLanguage)) {
            list.push({
                key: 'open-translate',
                label: t('articleMenu.openInTranslate'),
                icon: 'translate',
                testID: 'menu-open-translate',
                run: () => openInGoogleTranslate(articleUrl, appLanguage),
            });
        }
        if (publication) {
            list.push({
                key: 'fewer-from',
                label: t('articleMenu.fewerFrom', { source: publication }),
                icon: 'trending-down',
                testID: 'menu-fewer-from-source',
                run: () => fewerFromSource(publication),
            });
        }
        if (extraItems) list.push(...extraItems);
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
        return list;
    }, [
        t,
        subject.articleId,
        subject.suggestionId,
        subject.title,
        subject.publicationName,
        tracked,
        enterTree,
        onCheckFacts,
        surface,
        articleUrl,
        visit,
        languageCode,
        appLanguage,
        fewerFromSource,
        extraItems,
        rowActions,
    ]);

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

    const accessibilityActions = useMemo(
        () => [
            ...(inlineActions ?? []).map((i) => ({ name: `inline-${i.key}`, label: i.label })),
            ...items.map((i) => ({ name: i.key, label: i.label })),
        ],
        [items, inlineActions],
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
            const item = items.find((i) => i.key === name);
            if (item) runItem(item);
        },
        [items, runItem, inlineActions],
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
                    <Toast action="info" variant="solid">
                        <VStack>
                            <ToastTitle>{title}</ToastTitle>
                            {body ? <ToastDescription>{body}</ToastDescription> : null}
                        </VStack>
                    </Toast>
                ),
            });
        },
        [toast],
    );
    // The Undo toast names the leaf exactly as its row did (vars filled).
    const treeLabel = useCallback(
        (node: FeedbackTreeNode) => feedbackNodeLabel(t, node, treeContext),
        [t, treeContext],
    );
    const performLeaf = useCallback(
        (root: VerdictSentiment, node: FeedbackTreeNode, pathIds: string[]) =>
            performFeedbackLeaf(node, pathIds, {
                context: treeContext,
                chatContext: {
                    kind: 'article-suggestion',
                    articleId: subject.articleId,
                    suggestionId: subject.suggestionId,
                    articleTitle: subject.title,
                },
                chatMessage: t(
                    root === 'like' ? 'articleFeedback.thumbsUpMessage' : 'articleFeedback.thumbsDownMessage',
                    { title: subject.title },
                ),
                label: treeLabel(node),
                spend: { articleId: subject.articleId, sentiment: root },
                openChat: onFeedbackChat ? () => onFeedbackChat(root, pathIds) : undefined,
                browseRelated: onBrowseRelated ? () => onBrowseRelated(root) : undefined,
                closeThen,
                onLeafPicked: (p, applied, committed) => onLeafPicked?.(root, p, applied, committed),
                showInfo,
                chrome,
            }),
        [treeContext, subject, t, treeLabel, closeThen, onLeafPicked, onFeedbackChat, onBrowseRelated, showInfo, chrome],
    );

    const top = stack[stack.length - 1];
    const renderLevel = (level: SheetLevel): React.ReactNode => {
        switch (level.kind) {
            case 'main':
                return items.map((item) => (
                    <ActionSheetRow
                        key={item.key}
                        testID={item.testID}
                        label={item.label}
                        icon={item.icon}
                        opensLevel={item.opensLevel}
                        onPress={() => pick(item)}
                    />
                ));
            case 'tree':
                return tree ? (
                    <FeedbackTreeLevel
                        tree={tree}
                        root={level.root}
                        pathIds={level.pathIds}
                        context={treeContext}
                        onDescend={(node) =>
                            showLevel({ ...level, pathIds: [...level.pathIds, node.id] })
                        }
                        onLeaf={(node, pathIds) =>
                            leafNeedsConfirm(node)
                                ? showLevel({ kind: 'tree-confirm', root: level.root, node, pathIds })
                                : performLeaf(level.root, node, pathIds)
                        }
                    />
                ) : null;
            case 'tree-confirm':
                return (
                    <>
                        <SheetNote
                            title={chrome('confirmMuteTitle', 'Never show this publication?')}
                            body={chrome(
                                'confirmMuteBody',
                                "You won't see articles from {{publication}} again. You can undo this anytime.",
                                { publication: treeContext.publicationName ?? 'this publication' },
                            )}
                        />
                        <ActionSheetRow
                            testID="tree-confirm-destructive"
                            label={treeLabel(level.node)}
                            icon="block"
                            destructive
                            onPress={() => performLeaf(level.root, level.node, level.pathIds)}
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
            title={subject.title}
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
        element,
        accessibilityActions,
        onAccessibilityAction,
    };
}
