// The one Mera button's rules, as pure functions: where it shows, which page
// it speaks for while a switch is in flight, and which chat a tap opens.
//
// RN-free, so the rules are unit-tested on their own (MeraButtonHost wires
// them to expo-router's segments and the stores).

import { articleChatContext, type AskMeraSubject } from '@/components/custom/floating-chat/ask-mera';
import type { ChatContext } from '@/lib/stores/floating-chat-store';

/**
 * The full-screen wrapper the button is placed in. It must stay invisible to
 * accessibility: no testID, no accessible, modal or hiding flags, so Fabric
 * flattens it and no native full-screen view sits over the app. A
 * materialized one (it carried a testID) left the accessibility snapshot
 * with nothing but "Ask Mera". Only the button itself is an element.
 */
export const OVERLAY_PROPS = { pointerEvents: 'box-none' } as const;

/** What kind of route is showing, from expo-router's segments. */
export type MeraRouteKind = 'tab' | 'article' | 'search' | 'other';

const ARTICLE_ROUTES: ReadonlySet<string> = new Set(['article-detail', 'suggestion-detail']);

/**
 * The route allowlist: every screen under `app_container` (the four tabs and
 * what their stacks push), Search, and the two article pages. Everything else
 * (onboarding, the feedback-request modal, sign-in and gate screens) is
 * `other`, where the button never shows.
 */
export function routeKindFor(segments: readonly string[]): MeraRouteKind {
  if (segments[0] !== 'logged-in') return 'other';
  const head = segments[1];
  if (head === 'app_container') return 'tab';
  if (head === 'search') return 'search';
  if (head && ARTICLE_ROUTES.has(head)) return 'article';
  return 'other';
}

export interface VisibilityInput {
  readonly route: MeraRouteKind;
  /** The stored corner has loaded (no flash at a default corner on launch). */
  readonly hydrated: boolean;
  readonly chatOpen: boolean;
  readonly arrangeOpen: boolean;
  readonly keyboardUp: boolean;
}

/**
 * Whether the button shows. Never gated on focus or on the surface: those
 * lag a tab switch by a few frames, which is what made per-tab buttons blink.
 * On a tab the keyboard and World's Arrange hide it; on Search and an article
 * it rides above the keyboard instead (Search focuses its field on arrival).
 */
export function meraButtonVisible({ route, hydrated, chatOpen, arrangeOpen, keyboardUp }: VisibilityInput): boolean {
  if (route === 'other' || !hydrated || chatOpen) return false;
  if (route === 'tab' && (arrangeOpen || keyboardUp)) return false;
  return true;
}

/** A value that may briefly go null during a switch: keep the last real one. */
export function lastKnown<T>(previous: T | null, next: T | null): T | null {
  return next ?? previous;
}

/**
 * The chat a tap opens when the page alone does not decide it: an article
 * page opens Mera on that article. Undefined means "the page's own context"
 * (MeraButton derives it from the page key, the One interest fact included).
 */
export function buttonContextFor(route: MeraRouteKind, article: AskMeraSubject | null): ChatContext | undefined {
  if (route !== 'article' || !article) return undefined;
  return articleChatContext(article) ?? undefined;
}
