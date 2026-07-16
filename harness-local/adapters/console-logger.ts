// harness-local — console-backed HarnessLogger implementation.

import type { HarnessLogger } from '@/lib/news-harness/core/ports';

function fmtCtx(ctx?: Record<string, unknown>): string {
  if (!ctx || Object.keys(ctx).length === 0) return '';
  try {
    return ' ' + JSON.stringify(ctx);
  } catch {
    return ' [unserializable ctx]';
  }
}

const debugEnabled = () => process.env.NEWS_HARNESS_DEBUG === 'true';

export const consoleLogger: HarnessLogger = {
  debug(msg, ctx) {
    if (!debugEnabled()) return;
    // eslint-disable-next-line no-console
    console.debug(`[debug] ${msg}${fmtCtx(ctx)}`);
  },
  info(msg, ctx) {
    // eslint-disable-next-line no-console
    console.info(`[info] ${msg}${fmtCtx(ctx)}`);
  },
  warn(msg, ctx) {
    // eslint-disable-next-line no-console
    console.warn(`[warn] ${msg}${fmtCtx(ctx)}`);
  },
  error(msg, ctx) {
    // eslint-disable-next-line no-console
    console.error(`[error] ${msg}${fmtCtx(ctx)}`);
  },
};
