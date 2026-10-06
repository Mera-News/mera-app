// What the Mera button says and opens on each page.
//
// Pure: page id in, i18n keys and a ChatContext out. The hint pools live here
// and not in nav/page-registry so the one lane that writes chat copy owns them.
//
// EVERY HINT IS SOMETHING THE ROUTED AGENT CAN DO TODAY, on cloud and on
// device (owner ruling, navx). The persona agent saves, changes and removes
// facts and answers questions (with web search when it is on); the
// follow-story agent can only `proposeTrack`. Hints that need a proposal tool
// (countries, source mutes, topic weights) come back with
// plans/ready_to_implement/mera-settings-proposals.
//
// A hint marked `web` needs "Web search in chat". While that setting is off it
// is skipped, and a pool it empties shows no tooltip (owner ruling).

import type { SurfaceId } from '@/components/custom/nav/page-registry';
import type { FeedStatusMode } from '@/lib/feed-status-mode';
import type { ChatContext, MeraPageKey } from '@/lib/stores/floating-chat-store';

interface HintDef {
  readonly key: string;
  readonly web?: true;
}

const ASK_NEWS: HintDef = { key: 'meraHints.askNews', web: true };

const POOLS: Record<MeraPageKey, readonly HintDef[]> = {
  feed: [{ key: 'meraHints.feed.moreNews' }, { key: 'meraHints.feed.addHome' }, ASK_NEWS],
  interests: [
    { key: 'meraHints.interests.add' },
    { key: 'meraHints.interests.change' },
    { key: 'meraHints.interests.remove' },
  ],
  interest: [{ key: 'meraHints.interest.change' }, { key: 'meraHints.interest.remove' }],
  stories: [{ key: 'meraHints.stories.follow' }, { key: 'meraHints.stories.name' }],
  world: [
    { key: 'meraHints.world.countryFeed' },
    { key: 'meraHints.world.family' },
    { key: 'meraHints.world.behind', web: true },
  ],
  checks: [
    { key: 'meraHints.checks.claim', web: true },
    { key: 'meraHints.checks.quote', web: true },
  ],
  library: [ASK_NEWS, { key: 'meraHints.library.likeToRead' }],
  profile: [
    // Exact owner text, reused so its 20 translations survive.
    { key: 'profile.meraInviteReturning' },
    { key: 'meraHints.profile.fixFact' },
    { key: 'meraHints.profile.whatKnows' },
  ],
  facts: [{ key: 'meraHints.facts.change' }, { key: 'meraHints.facts.remove' }],
  sources: [{ key: 'meraHints.sources.whoBehind', web: true }, { key: 'meraHints.sources.whatFollow' }],
};

const DIRECT: Readonly<Record<string, MeraPageKey>> = {
  feed: 'feed',
  interests: 'interests',
  stories: 'stories',
  world: 'world',
  checks: 'checks',
  saved: 'library',
  visited: 'library',
  stats: 'library',
  profile: 'profile',
  facts: 'facts',
  sources: 'sources',
  // The other View-all screens on You carry no pool of their own: the Profile
  // hints fit them (they all edit what Mera knows).
  locations: 'profile',
  hygiene: 'profile',
  'not-interested': 'profile',
  activity: 'profile',
};

/** Pages whose chat edits facts: their close may owe the combination topic
 *  pass, which only runs for `origin: 'profile'` (ux2 F2). */
const FACT_EDITING: ReadonlySet<MeraPageKey> = new Set([
  'profile',
  'facts',
  'sources',
  'interests',
  'interest',
]);

/**
 * The page key for a surface id, or null where the button does not show:
 * settings and its sub-screens, search, and anything this table does not know
 * (a hidden button beats one that opens the wrong chat).
 */
export function pageKeyFor(surface: SurfaceId | null | undefined): MeraPageKey | null {
  if (!surface) return null;
  if (surface.startsWith('country:')) return 'world';
  if (surface.startsWith('interest:')) return 'interest';
  return DIRECT[surface] ?? null;
}

/** The fact id of a One interest surface (`interest:<factId>`), else null. */
export function interestFactId(surface: string | null | undefined): string | null {
  if (!surface?.startsWith('interest:')) return null;
  const id = surface.slice('interest:'.length);
  return id.length > 0 ? id : null;
}

/** The page's hint keys, in rotation order, minus web hints while web search is off. */
export function hintKeys(page: MeraPageKey, webSearch: boolean): string[] {
  return POOLS[page].filter((h) => webSearch || !h.web).map((h) => h.key);
}

/** The chat the button opens. `subject` is the fact statement on One interest. */
export function chatContextFor(page: MeraPageKey, subject?: string): ChatContext {
  if (page === 'stories') return { kind: 'follow-story', page: 'stories' };
  return {
    kind: 'persona',
    page,
    ...(FACT_EDITING.has(page) ? { origin: 'profile' as const } : {}),
    ...(page === 'interest' && subject ? { subject } : {}),
  };
}

/** The intro line the chat opens with (client-side, zero model calls). */
export function introKeyFor(page: MeraPageKey, webSearch: boolean): string {
  if (page === 'stories') return 'trackedStories.followChatIntro';
  if (page === 'checks' && !webSearch) return 'meraIntro.checksNoWeb';
  return `meraIntro.${page}`;
}

export interface PageStarter {
  /** i18n key of the chip label (the hint itself). */
  readonly labelKey: string;
  /** What lands in the composer: an i18n key plus its options. */
  readonly draftKey: string;
  readonly draftOptions?: Readonly<Record<string, string>>;
}

/**
 * The page's starters: every hint in the pool as a chip whose tap fills the
 * composer, never sends (owner ruling). On One interest the two drafts carry
 * the fact itself, because the page never reaches the model.
 */
export function pageStarters(
  page: MeraPageKey,
  webSearch: boolean,
  subject?: string,
): PageStarter[] {
  return hintKeys(page, webSearch).map((labelKey) => {
    if (page === 'interest' && subject) {
      const draftKey =
        labelKey === 'meraHints.interest.remove'
          ? 'meraDraft.removeInterest'
          : 'meraDraft.changeInterest';
      return { labelKey, draftKey, draftOptions: { statement: subject } };
    }
    return { labelKey, draftKey: labelKey };
  });
}

/** The button's accessibility value: the four status strings the header mark
 *  used (feedStatus.*). Deferred reads as up to date, as it always has. */
export function statusKey(mode: FeedStatusMode): string {
  switch (mode) {
    case 'processing':
      return 'feedStatus.modeProcessing';
    case 'error':
      return 'feedStatus.modeError';
    case 'limited':
      return 'feedStatus.modeLimited';
    default:
      return 'feedStatus.idle';
  }
}

/** Every i18n key this module can return, for the en.json presence test. */
export function allKeys(): string[] {
  const keys = new Set<string>();
  for (const pool of Object.values(POOLS)) for (const h of pool) keys.add(h.key);
  for (const page of Object.keys(POOLS) as MeraPageKey[]) {
    keys.add(introKeyFor(page, true));
    keys.add(introKeyFor(page, false));
  }
  keys.add('meraDraft.changeInterest');
  keys.add('meraDraft.removeInterest');
  return [...keys];
}
