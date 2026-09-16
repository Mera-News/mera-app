import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { gameAnimationFor } from '@/components/custom/game-ui/animation-registry';
import { PROCESSING_SCENE_SIZE } from '@/components/custom/processing/types';
import { useForYouDailyLimitResetAt } from '@/lib/stores/selectors';
import { router } from 'expo-router';
import LottieView from 'lottie-react-native';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The empty-state card for "today's article cap is reached and nothing more
 * will be fetched".
 *
 * It exists because the empty-state chain had no branch for the capped state,
 * so a capped reader fell through to FeedProcessingCard and was told "Mera is
 * preparing your feed" while the status indicator in the SAME header said
 * "Daily article limit reached". Two surfaces on one screen, contradicting each
 * other, and the card was the one that was false: nothing was being prepared
 * and nothing would be.
 *
 * Three deliberate choices:
 *
 * 1. The scene is HELD AT FRAME 0, never looped. A loop says something is
 *    arriving. Nothing is arriving until the cap resets, so a breathing idle
 *    animation here would be the same lie in a different medium. This mirrors
 *    the offline empty state, which freezes the same scene for the same reason.
 *
 * 2. The time is formatted from an absolute instant in the DEVICE's timezone,
 *    and there is no untimed fallback. The cap resets at 00:00 UTC, which is
 *    5pm the SAME DAY in Los Angeles, so any copy saying "tomorrow" is false
 *    for a large share of readers. `feed.dailyLimit.body`, the untimed string,
 *    still exists in all 20 dictionaries and still has no consumer. Leave it
 *    that way. FeedSyncMachine falls back to the next UTC midnight whenever the
 *    server omits a reset instant, so an instant always exists.
 *
 * 3. No upgrade button. The cap is a plan limit and management is a real
 *    action, but it already sits one tap away in the status panel, and both
 *    purchase paths land on an email form first for anonymous accounts. An
 *    upgrade pill on the one screen a capped reader cannot avoid is a nag, not
 *    an affordance. Explore is offered instead, which is what the body copy
 *    already tells them to do.
 */
const DailyLimitCard: React.FC = () => {
    const { t } = useTranslation();
    const dailyLimitResetAt = useForYouDailyLimitResetAt();

    const resetTime = dailyLimitResetAt
        ? new Date(dailyLimitResetAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
          })
        : '';

    return (
        <Box
            testID="feed-daily-limit"
            className="w-full py-20 px-6 items-center justify-center"
        >
            {/* Same size and offset as FeedProcessingCard's stage scene and the
                all-caught-up card's idle scene, so swapping between the three
                empty states never makes the artwork jump. */}
            <Box
                testID="daily-limit-scene"
                className="mb-6"
                style={{ width: PROCESSING_SCENE_SIZE, height: PROCESSING_SCENE_SIZE }}
            >
                <LottieView
                    source={gameAnimationFor('game-hud-idle') as never}
                    autoPlay={false}
                    progress={0}
                    loop={false}
                    renderMode="AUTOMATIC"
                    resizeMode="contain"
                    style={{ flex: 1 }}
                />
            </Box>

            <Text
                testID="daily-limit-headline"
                size="xl"
                className="text-white text-center font-semibold mb-4"
            >
                {t('feed.dailyLimit.title')}
            </Text>

            <Text size="md" className="text-gray-400 text-center">
                {t('feed.dailyLimit.bodyWithTime', { time: resetTime })}
            </Text>

            <Button
                testID="daily-limit-explore-cta"
                variant="outline"
                action="secondary"
                size="sm"
                className="mt-6"
                onPress={() => router.navigate('/logged-in/app_container/around')}
            >
                <ButtonText>{t('feed.exploreCta')}</ButtonText>
            </Button>
        </Box>
    );
};

export default DailyLimitCard;
