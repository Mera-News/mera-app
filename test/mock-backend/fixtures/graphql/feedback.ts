import type { FeedbackRequestView } from '@/lib/generated/graphql-types';

/** No open feedback requests by default; a test that wants one overrides the op. */
export const feedbackRequests: FeedbackRequestView[] = [];
