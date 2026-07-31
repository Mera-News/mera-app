// THE COMPOSITION ROOT for env-bound harness config.
//
// `lib/news-harness/**` is RN-free ports-and-adapters code and never reads
// `process.env`; anything env-driven is resolved here, once, and handed to the
// engine as plain `HarnessConfig` data.
//
// Its own module (rather than a const inside stage-scoring.ts) for two reasons:
// it is a pure value with no database dependency, and stage-scoring.ts is
// wholesale-mocked by several suites — a consumer that only needs the tag policy
// should not have to reach through a mocked orchestrator to get it.
//
// Note this is the BASE. `stage-scoring::effectiveHarnessConfig()` layers the
// persisted calibration overrides on top of it and is what the scoring paths
// actually call.

import { USE_ARTICLE_TAGS } from '@/lib/config/endpoints';
import { DEFAULT_HARNESS_CONFIG, type HarnessConfig } from '@/lib/news-harness/core/config';

/**
 * `DEFAULT_HARNESS_CONFIG` with `EXPO_PUBLIC_USE_ARTICLE_TAGS` folded in.
 *
 * When the env value matches the harness default (the normal case — both are
 * OFF) this is `DEFAULT_HARNESS_CONFIG` ITSELF, not a copy. That keeps the
 * common path allocation-free and, more importantly, preserves the
 * reference-equality fast path `applyScoringOverrides` relies on to return the
 * base object untouched when there are no calibration overrides.
 */
export const HARNESS_CONFIG_BASE: HarnessConfig =
  USE_ARTICLE_TAGS === DEFAULT_HARNESS_CONFIG.scoringEngine.USE_ARTICLE_TAGS
    ? DEFAULT_HARNESS_CONFIG
    : {
        ...DEFAULT_HARNESS_CONFIG,
        scoringEngine: {
          ...DEFAULT_HARNESS_CONFIG.scoringEngine,
          USE_ARTICLE_TAGS,
        },
      };
