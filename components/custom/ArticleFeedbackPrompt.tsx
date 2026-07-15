import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip';
import {
    hasLiked,
    recordArticleFeedback,
    removeArticleFeedback,
} from '@/lib/database/services/article-feedback-service';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ArticleFeedbackPromptProps {
    articleId: string;
    suggestionId?: string;
    title: string;
}

// Primary-orange accent for the three feedback buttons. Dark-locked: these
// stay orange-on-dark regardless of app theme. (Close to primary-500 but not an
// exact token match, so the hex is used directly.)
const PRIMARY = '#EDA77E';
// Icon color when a button is in its filled/selected state — dark for contrast
// against the orange fill.
const SELECTED_ICON = '#1a1a1a';

const ICON_SIZE = 19;
const BUTTON_SIZE = 45;

type FeedbackKind = 'like' | 'dislike';

/**
 * Prominent "What do you think of this article?" widget rendered directly
 * under the reason box on the article detail screens. Single row: the title on
 * the left (wraps to 2 lines if needed) and three round, primary-orange-outlined
 * buttons grouped on the right:
 *   - Chat with Mera → opens the floating Mera chat for this article (plain
 *     open, no auto-sent message) — replaces the old floating chat bubble. Bare
 *     logo button, no label (not even on long-press) — matches the old
 *     floating chat bubble treatment.
 *   - Like → tracked locally only (no chat); persists a `like` row and shows a
 *     filled selected treatment, restored on remount via `hasLiked`. Toggleable —
 *     re-tapping an already-liked button un-likes it, removing the row and
 *     clearing the filled treatment.
 *   - Dislike → opens the floating Mera chat with an article-feedback
 *     conversation and auto-sends an initial message.
 * The like/dislike buttons show their label on long-press (gluestack Tooltip)
 * and always set an accessibilityLabel.
 */
export const ArticleFeedbackPrompt: React.FC<ArticleFeedbackPromptProps> = ({
    articleId,
    suggestionId,
    title,
}) => {
    const { t } = useTranslation();
    const [liked, setLiked] = useState(false);
    const [tipOpen, setTipOpen] = useState<FeedbackKind | null>(null);

    // Restore the "liked" acknowledgment across remounts (e.g. leaving and
    // reopening the article).
    useEffect(() => {
        let cancelled = false;
        hasLiked(articleId)
            .then((v) => {
                if (!cancelled && v) setLiked(true);
            })
            .catch(() => {
                /* non-fatal — default to not-liked */
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    const handleLike = useCallback(() => {
        if (liked) {
            hapticLight();
            setLiked(false);
            void removeArticleFeedback(articleId, 'like');
            return;
        }
        hapticSuccess();
        setLiked(true);
        void recordArticleFeedback({
            articleId,
            suggestionId,
            sentiment: 'like',
            title,
        });
    }, [liked, articleId, suggestionId, title]);

    const openChat = useCallback(
        (messageKey: 'articleFeedback.thumbsDownMessage') => {
            hapticMedium();
            useFloatingChatStore.getState().openArticleFeedback(
                { kind: 'article-suggestion', articleId, suggestionId, articleTitle: title },
                t(messageKey, { title }),
            );
        },
        [articleId, suggestionId, title, t],
    );

    const handleChatPress = useCallback(() => {
        hapticMedium();
        useFloatingChatStore.getState().expand({
            kind: 'article-suggestion',
            articleId,
            suggestionId,
            articleTitle: title,
        });
    }, [articleId, suggestionId, title]);

    const renderButton = (
        kind: FeedbackKind,
        icon: React.ReactNode,
        label: string,
        onPress: () => void,
        selected: boolean,
    ) => (
        <Tooltip
            placement="top"
            isOpen={tipOpen === kind}
            onClose={() => setTipOpen((k) => (k === kind ? null : k))}
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    onPress={onPress}
                    onLongPress={() => setTipOpen(kind)}
                    onPressOut={() => setTipOpen((k) => (k === kind ? null : k))}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    className="items-center justify-center rounded-full"
                    style={{
                        width: BUTTON_SIZE,
                        height: BUTTON_SIZE,
                        backgroundColor: selected ? PRIMARY : 'transparent',
                        borderWidth: 1.75,
                        borderColor: PRIMARY,
                    }}
                >
                    {icon}
                </Pressable>
            )}
        >
            <TooltipContent>
                <TooltipText>{label}</TooltipText>
            </TooltipContent>
        </Tooltip>
    );

    return (
        <HStack space="md" className="items-center px-1">
            <Text className="flex-1 text-base font-medium text-typography-100">
                {t('articleFeedback.widgetTitle')}
            </Text>
            <HStack space="xl" className="items-center justify-end">
                <Pressable
                    onPress={handleChatPress}
                    accessibilityRole="button"
                    accessibilityLabel="Mera"
                    className="items-center justify-center rounded-full"
                    style={{
                        width: BUTTON_SIZE,
                        height: BUTTON_SIZE,
                        backgroundColor: 'transparent',
                        borderWidth: 1.75,
                        borderColor: PRIMARY,
                    }}
                >
                    <MeraLogo size={28} />
                </Pressable>
                {renderButton(
                    'like',
                    <MaterialIcons
                        name="thumb-up"
                        size={ICON_SIZE}
                        color={liked ? SELECTED_ICON : PRIMARY}
                    />,
                    t('articleFeedback.likeLabel'),
                    handleLike,
                    liked,
                )}
                {renderButton(
                    'dislike',
                    <MaterialIcons name="thumb-down" size={ICON_SIZE} color={PRIMARY} />,
                    t('articleFeedback.dislikeLabel'),
                    () => openChat('articleFeedback.thumbsDownMessage'),
                    false,
                )}
            </HStack>
        </HStack>
    );
};

export default ArticleFeedbackPrompt;
