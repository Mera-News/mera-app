// Incoming system links (deep links, the QA harness, a push opening a URL)
// from before navx name routes that moved into the four tabs. Rewrite them
// before routing: the table is lib/algorithms/legacy-href.ts, shared with the
// pending-notification store. A target that names a page leaves it in the
// one-shot pending store (no page state in URLs); TabPages opens it on focus.
// An "Add to Mera News" link (/add/<publisherId>) goes through the startup gate first.
import { setPendingPage } from '@/components/custom/nav/navigate-to-page';
import { addSourceIdFromPath, routeAddSourceLink } from '@/components/custom/publication-page/add-source-from-link';
import { normalizeLegacyHref } from '@/lib/algorithms/legacy-href';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const addId = addSourceIdFromPath(path);
    if (addId) return routeAddSourceLink(addId);
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
