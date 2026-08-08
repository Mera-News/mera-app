// news-harness — the TutorialHelpAgent's portable brain (PURE, RN-free).
//
// The product-help chat opened from an "Ask Mera" button on a tutorial slide.
// It answers questions about HOW MERA WORKS. It changes nothing, and it has no
// tools at all — that absence is the whole design.
//
// ── Why this module exists ──────────────────────────────────────────────────
// `components/custom/floating-chat/agent-registry.ts` used to route the
// `{ kind: 'generic' }` context straight to `PersonaUpdateAgent`, whose prompt
// instructs it to stay on profile/news topics and redirect anything else, and
// which mandates at least one `saveExtractedFacts` call on every turn. A
// tutorial question ("what is the Explore tab for?") therefore got politely
// deflected AND silently mutated the reader's profile. The failure is invisible
// — the popover morphs, a reply streams, it is simply the wrong agent — which is
// exactly why the tutorial button must never point at a persona context, and why
// a mis-wire has to be caught by reading the ANSWER rather than by checking that
// one arrived.
//
// Everything touching WatermelonDB, Zustand, the logger or any expo/RN module
// stays in lib/llm/agents/TutorialHelpAgent.ts.

/** Replies are read on a slide, next to the copy they are about. Keep them short. */
const MAX_SENTENCES = 3;

export interface TutorialHelpPromptInput {
  /** Prompt language, resolved by the adapter from the app language store. */
  languageName?: string;
}

/**
 * The system prompt.
 *
 * Four constraints are load-bearing rather than stylistic:
 *
 *  1. **It cannot change anything, and must never imply otherwise.** It has no
 *     tools. A reply like "I've turned that off for you" would be a lie the user
 *     acts on.
 *  2. **It must not contradict the chapters.** The privacy chapter says cloud is
 *     the default and decoy padding is opt-in; a model repeating the marketing
 *     version of either would undo the one thing that chapter exists to correct.
 *  3. **It must admit ignorance.** The alternative is a confident invention about
 *     a screen that does not exist, which is worse than a pointer to the FAQ.
 *  4. **Plain words.** The audience for this module is explicitly someone's
 *     mother. "Persona", "embedding", "cluster" and "vector" are all vocabulary
 *     the app itself is trying to stop leaking.
 */
export function buildTutorialHelpPrompt(input: TutorialHelpPromptInput = {}): string {
  const { languageName } = input;

  const languageRule = languageName
    ? `LANGUAGE: ALWAYS reply in **${languageName}**, with no exceptions — even if the user writes in another language.`
    : "LANGUAGE: Match the user's language, and switch if they switch.";

  return `You are Mera, answering a question about how the mera app works. The user is reading a short in-app guide and tapped "Ask Mera" on one of its cards.

## What you do
Explain how mera works, in plain words, in at most ${MAX_SENTENCES} short sentences. Nothing else.

## What you cannot do
You have NO tools in this conversation. You cannot change a setting, add or remove a fact, adjust the feed, or follow a story. NEVER say or imply that you have changed anything, and never offer to. If the user asks you to change something, tell them where in the app to do it themselves.

## If you do not know
Say so plainly in one sentence and point them at Settings → FAQ. Do not guess at a screen, a button or a setting you are unsure exists. An honest "I'm not sure" is a correct answer here.

## Facts you must not get wrong
- The default processing mode is CLOUD, using encrypted inference. On-device is a setting the user can switch on; it is not the default.
- Decoy topics ("Inject noise") are OFF by default. They are a switch the user turns on, not something already running.
- The user's facts, interests and reading history stay on their phone. What leaves is short topic phrases carrying no user ID, plus their email and plan.
- In the Feed nothing is ever removed: a story the user has read SINKS below a divider and stays readable.
- A thumbs up or down with no reason attached is discarded — the reason is what changes anything.
- Muting a source keeps it out entirely; the down arrow only makes it rarer. They are different controls on different screens.

## How to write
Plain, warm, concrete. No jargon: never say "persona", "embedding", "vector", "cluster" or "model" to the user. Name what they can see and tap. Do not use bullet lists — this is a two or three sentence answer read on a small card.

${languageRule}`;
}

/**
 * The `<context>` block: which slide the reader is on.
 *
 * `route` is the string `AskMeraButton` puts on the chat context
 * (`tutorials/<chapter>/<slide>`), and it is the ONLY context this agent gets.
 * Deliberately not the user's facts, topics or reading history: this chat is
 * about the app, and pulling a profile into it would be the same category error
 * as routing it to the persona agent in the first place.
 */
export function buildTutorialHelpContext(route: string | null | undefined): string {
  const parsed = parseTutorialRoute(route);
  if (!parsed) return '<context>\nThe user is reading the in-app guide.\n</context>';

  return `<context>
The user is reading the in-app guide, on the "${parsed.chapterId}" chapter, card "${parsed.slideId}".
Answer about THAT part of the app unless they clearly ask about something else.
</context>`;
}

export interface ParsedTutorialRoute {
  readonly chapterId: string;
  readonly slideId: string;
}

/**
 * `tutorials/<chapter>/<slide>` → its parts, or `null` for anything else.
 *
 * Tolerant on purpose: the `{ kind: 'generic' }` context is a shared seam that
 * other surfaces are expected to start using for route-aware help, so an
 * unrecognised route must degrade to "no slide context" rather than throw inside
 * a prompt builder.
 */
export function parseTutorialRoute(
  route: string | null | undefined,
): ParsedTutorialRoute | null {
  if (!route) return null;
  const parts = route.split('/').filter((p) => p.length > 0);
  if (parts.length !== 3 || parts[0] !== 'tutorials') return null;
  return { chapterId: parts[1], slideId: parts[2] };
}
