// Incoming system links (deep links, the QA harness, a push opening a URL)
// from before navx name routes that moved into the four tabs. Rewrite them
// before routing: the table is lib/navigation/legacy-href.ts, shared with the
// pending-notification store. A target that names a page leaves it in the
// one-shot pending store (no page state in URLs); TabPages opens it on focus.
import { setPendingPage } from '@/components/custom/nav/navigate-to-page';
import { normalizeLegacyHref } from '@/lib/navigation/legacy-href';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const target = normalizeLegacyHref(path);
    if (!target) return path;
    if (target.page) {
      setPendingPage(target.page);
      return target.pathname;
    }
    const query = target.params ? new URLSearchParams(target.params).toString() : '';
    return query ? `${target.pathname}?${query}` : target.pathname;
  } catch {
    // Never block a link over a rewrite: route it as it came.
    return path;
  }
}
