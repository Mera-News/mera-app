import ArticleOverflowMenu, { type ArticleMenuItem } from '@/components/custom/cards/ArticleOverflowMenu';
import {
    isForeignLanguage,
    openInGoogleTranslate,
    openOnSource,
    type VisitInput,
} from '@/components/custom/cards/article-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { askMeraAbout } from '@/components/custom/floating-chat/ask-mera';
import MeraLogo from '@/components/custom/MeraLogo';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastTitle, useToast } from '@/components/ui/toast';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { showFeedback } from '@/lib/feedback';
import { SENTRY_ENABLED } from '@/lib/sentry-init';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AccessibilityActionEvent } from 'react-native';

/** Long enough for the sheet's fade-out to finish, so a follow-up surface (the
 *  feedback form, a chat, a browser) never opens underneath the closing sheet. */
export const MENU_CLOSE_MS = 250;

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
 * Every item runs AFTER the sheet has closed (MENU_CLOSE_MS), which matters
 * for "Report a bug" (the form must not open under a closing modal) and for
 * anything that opens another surface. A failed item says so with a retry.
 *
 * Report a bug NEVER attaches the article's id or URL: that would be a record
 * of which article this user read, which invariant 9 rules out.
 */
export function useArticleMenu(input: UseArticleMenuInput): UseArticleMenu {
    const { t } = useTranslation();
    const toast = useToast();
    const appLanguage = useAppLanguage();
    const [visible, setVisible] = useState(false);
    // The follow state is read only once the menu has been opened (or a
    // VoiceOver action used): a DB read per mounted card, just to label an item
    // nobody has looked at, is waste. It stays live after that, because items
    // run after the sheet has closed.
    const [engaged, setEngaged] = useState(false);
    const { subject, surface, articleUrl, languageCode, visit, onCheckFacts, extraItems } = input;
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

    const close = useCallback(() => setVisible(false), []);
    const pick = useCallback(
        (item: ArticleMenuItem) => {
            setVisible(false);
            setTimeout(() => runItem(item), MENU_CLOSE_MS);
        },
        [runItem],
    );

    const accessibilityActions = useMemo(
        () => items.map((i) => ({ name: i.key, label: i.label })),
        [items],
    );
    const onAccessibilityAction = useCallback(
        (e: AccessibilityActionEvent) => {
            setEngaged(true);
            const item = items.find((i) => i.key === e.nativeEvent.actionName);
            if (item) runItem(item);
        },
        [items, runItem],
    );

    const element = (
        <>
            {trackDialog}
            <ArticleOverflowMenu visible={visible} onClose={close} items={items} onPick={pick} />
        </>
    );

    return {
        open: useCallback(() => {
            setEngaged(true);
            setVisible(true);
        }, []),
        element,
        accessibilityActions,
        onAccessibilityAction,
    };
}
