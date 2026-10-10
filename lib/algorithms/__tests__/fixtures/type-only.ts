// Control fixture for purity.test.ts: type-only imports carry no runtime code, so none is flagged.
import type { TFunction } from 'i18next';
import type { FeedbackTree } from '@/lib/news-harness/feedback-tree/types';

export type Planted = [TFunction, FeedbackTree];
