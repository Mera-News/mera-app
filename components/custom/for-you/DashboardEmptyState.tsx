// What the Dashboard's Overview list shows when it has no sections.
//
// Its own component, passed to the list as an ELEMENT (S11). It used to be a
// `useCallback` in ForYouScreen handed to `ListEmptyComponent` as a component
// TYPE, so every change to any of its nine inputs made a new type and the
// whole empty state (a Lottie scene, a processing card) unmounted and mounted
// again. An element of one stable type is reconciled in place instead.

import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import DailyLimitCard from '@/components/custom/DailyLimitCard';
import NoGeneratedInterestsCard from '@/components/custom/NoGeneratedInterestsCard';
import FeedProcessingCard from '@/components/custom/processing/FeedProcessingCard';
import OnboardingWaitingCard from '@/components/custom/for-you/OnboardingWaitingCard';
import { Box } from '@/components/ui/box';
import { AlertCircleIcon, Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface DashboardEmptyStateProps {
  readonly showOnboardingWait: boolean;
  readonly isLoading: boolean;
  readonly stuckOnEmpty: boolean;
  readonly errorMessage: string | null | undefined;
  readonly hasGeneratedInterests: boolean;
  readonly statusMode: FeedStatusMode;
  readonly isFeedProcessing: boolean;
  readonly lastProcessingRunFinishedAt: number | null;
}

const DashboardEmptyState: React.FC<DashboardEmptyStateProps> = ({
  showOnboardingWait,
  isLoading,
  stuckOnEmpty,
  errorMessage,
  hasGeneratedInterests,
  statusMode,
  isFeedProcessing,
  lastProcessingRunFinishedAt,
}) => {
  const { t } = useTranslation();

  if (showOnboardingWait) {
    return <OnboardingWaitingCard />;
  }
  if (isLoading && !stuckOnEmpty) {
    return (
      <Box className="items-center justify-center py-20" testID="dashboard-loading">
        <Spinner size="large" />
      </Box>
    );
  }
  if (stuckOnEmpty) {
    return (
      <Box className="items-center justify-center py-20 px-6" testID="dashboard-stuck-empty">
        <Icon as={AlertCircleIcon} size="xl" className="text-error-400 mb-3" />
        <Text size="md" className="text-error-400 text-center font-semibold mb-1">
          {t('feed.stuckTitle')}
        </Text>
        <Text size="sm" className="text-typography-400 text-center">
          {t('feed.stuckDescription')}
        </Text>
        <Text size="xs" className="text-typography-500 text-center mt-3">
          {t('feed.stuckHint')}
        </Text>
      </Box>
    );
  }
  if (errorMessage) {
    return (
      <Box className="items-center justify-center py-20 px-6" testID="dashboard-error">
        <Icon as={AlertCircleIcon} size="xl" className="text-error-400 mb-3" />
        <Text size="md" className="text-error-400 text-center font-semibold mb-1">
          {t('errors.failedToLoad')}
        </Text>
        <Text size="sm" className="text-typography-400 text-center">
          {errorMessage}
        </Text>
        <Text size="xs" className="text-typography-500 text-center mt-3">
          {t('feed.pullDownToRetry')}
        </Text>
      </Box>
    );
  }
  if (!hasGeneratedInterests) {
    return <NoGeneratedInterestsCard />;
  }
  // Capped, with nothing in flight. Must come BEFORE the processing branch:
  // `useFeedStatusMode` ranks processing above limited, so a real run still
  // reports 'processing' and still reaches the card below. This catches the
  // case that used to fall through and claim the feed was being prepared while
  // the header indicator said the limit was reached.
  if (statusMode === 'limited') {
    return <DailyLimitCard />;
  }
  if (isFeedProcessing || lastProcessingRunFinishedAt === null) {
    return <FeedProcessingCard />;
  }
  return <AllCaughtUpCard />;
};

export default DashboardEmptyState;
