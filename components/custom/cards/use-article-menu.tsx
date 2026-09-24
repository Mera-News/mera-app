import ArticleOverflowMenu, { type ArticleMenuItem } from '@/components/custom/cards/ArticleOverflowMenu';
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
import { Toast, ToastTitle, useToast } from '@/components/ui/toast';
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
}

export interface UseArticleMenu {
    open: () => void;
    /** Mount once near the surface root: the sheet plus the follow dialogs. */
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
 * `onDismiss` on iOS, once the Modal is hidden on Android (RN has no
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
    const { subject, surface, articleUrl, languageCode, visit, onCheckFacts, extraItems, inlineActions } = input;
    const { tracked, onPress: onTrackPress, dialog: trackDialog } = useTrackButton(subject, engaged);

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
            toast.show({
                placement: 'top',
                duration: 6000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="info" variant="solid">
                        <ToastTitle>{t('articleMenu.fewerFromDone', { source: publicationName })}</ToastTitle>
                        <Pressable
                            testID="article-menu-undo"
                            accessibilityRole="button"
                            accessibilityLabel={t('articleMenu.undo')}
                            hitSlop={12}
                            onPress={() => {
                                toast.close(id);
                                void setSourcePrefFromUi({ kind: 'publication', publicationName }, 'none');
                            }}
                        >
                            <Text className="font-semibold text-white">{t('articleMenu.undo')}</Text>
                        </Pressable>
                    </Toast>
                ),
            });
            return true;
        },
        [toast, t],
    );

    const items = useMemo<ArticleMenuItem[]>(() => {
        const list: ArticleMenuItem[] = [];
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
            run: () => onTrackPress(),
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
        onTrackPress,
        onCheckFacts,
        surface,
        articleUrl,
        visit,
        languageCode,
        appLanguage,
        fewerFromSource,
        extraItems,
    ]);

    // The sheet stays mounted while its Modal dismisses; `pending` holds the
    // picked item until the dismissal is reported. See the header.
    const [mounted, setMounted] = useState(false);
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

    const onDismissed = useCallback(() => {
        flushPending();
        setMounted(false);
    }, [flushPending]);

    const close = useCallback(() => setVisible(false), []);
    const pick = useCallback(
        (item: ArticleMenuItem) => {
            pendingRef.current = item;
            setVisible(false);
            if (fallbackRef.current) clearTimeout(fallbackRef.current);
            fallbackRef.current = setTimeout(onDismissed, MENU_DISMISS_FALLBACK_MS);
        },
        [onDismissed],
    );

    // Android has no `onDismiss`: the Modal is gone once it renders hidden.
    useEffect(() => {
        if (Platform.OS !== 'ios' && mounted && !visible) onDismissed();
    }, [mounted, visible, onDismissed]);

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

    const element = (
        <>
            {trackDialog}
            <ArticleOverflowMenu
                mounted={mounted}
                visible={visible}
                onDismiss={Platform.OS === 'ios' ? onDismissed : undefined}
                title={subject.title}
                onClose={close}
                items={items}
                onPick={pick}
            />
        </>
    );

    return {
        open: useCallback(() => {
            setEngaged(true);
            setMounted(true);
            setVisible(true);
        }, []),
        element,
        accessibilityActions,
        onAccessibilityAction,
    };
}
