// App-side adapter that satisfies the harness's HarnessLogger port using the
// real (Sentry-backed) lib/logger. Lives OUTSIDE lib/news-harness/ so the
// harness directory itself never imports @sentry/react-native.

import logger from '@/lib/logger';
import type { HarnessLogger } from '@/lib/news-harness/core/ports';

export const appHarnessLogger: HarnessLogger = {
  debug: (msg, ctx) => logger.debug(msg, ctx),
  info: (msg, ctx) => logger.info(msg, ctx),
  warn: (msg, ctx) => logger.warn(msg, ctx),
  error: (msg, ctx) => logger.error(msg, undefined, ctx),
};
