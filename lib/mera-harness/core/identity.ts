// mera-harness/core: who the chat assistant is. PURE, RN-free.
//
// The one place every chat surface takes its identity from. A surface passes
// what its tools and skills really do and whether webSearch is offered this turn,
// so nothing here claims a tool the turn does not have. The claims are about
// "you", the chat assistant: the server fact check runs elsewhere, on grounded
// search whose reading Mera cannot see.

/** What a surface's tools and skills do. List only what that surface offers. */
export type MeraAbility = 'profile' | 'feed' | 'follow' | 'articleContext' | 'newsContext' | 'factCheck' | 'howMeraWorks';

const ABILITY_LINES: Record<MeraAbility, string> = {
  profile: 'manage their profile: the facts they share, the topics made from them',
  feed: 'tune their feed: more or less of a topic, an outlet or a country',
  follow: 'follow news stories',
  articleContext: 'get more context on this news article',
  newsContext: 'get more context on a news story',
  factCheck: 'fact check the claims in this article',
  howMeraWorks: 'understand how Mera works',
};

/** Said in the owner's words when a reader asks why. */
export const WHY_NO_PAGES =
  'Publishers own their articles, so Mera works from search results and the headline and short description publishers put in their feeds, and links out to the publisher rather than reproducing the article.';

const NO_PAGES = 'You do not open a page or read an article.';
const CAN_SEARCH = 'You can make a web search request and give context based on the search results.';

export interface MeraIdentityInput {
  abilities: readonly MeraAbility[];
  /** webSearch is offered on this turn. */
  webSearch: boolean;
}

const who = (abilities: readonly MeraAbility[]): string => `## Who you are
You are Mera, a news assistant. In this chat you help the reader:
${abilities.map((a) => `- ${ABILITY_LINES[a]}`).join('\n')}`;

/**
 * The route leg's identity: who it is and nothing about pages. That leg alone
 * streams and its only text is the acknowledgement, so a rule about what it
 * cannot do came straight out as a live "I can't open that".
 */
export function meraRouteIdentity({ abilities, webSearch }: MeraIdentityInput): string {
  return webSearch ? `${who(abilities)}\n\n${CAN_SEARCH}` : who(abilities);
}

export function meraIdentity({ abilities, webSearch }: MeraIdentityInput): string {
  const search = webSearch
    ? CAN_SEARCH
    : 'You have no web search right now. When a request needs it, say: "Web search is switched off in your settings. You can turn on Web search in chat in Mera Protocol settings."';
  const instead = webSearch ? ' and offer to search for it instead' : '';
  const yes = webSearch ? ' When they ask whether you can search or browse the web, the answer is yes: you search and work from the results.' : '';
  return `${who(abilities)}

${search} ${NO_PAGES}${yes} When a reader shares a link or asks you to open or read something, tell them you cannot open it${instead}. Keep the reason for when they ask why, and then say: "${WHY_NO_PAGES}"`;
}

/** Every on-device instruction opens with this. A built-in model otherwise names
 *  its maker. Each word counts: Gemini Nano wants these prompts under 150 words,
 *  and the longest sits four below that without this line's last sentence. */
export const IDENTITY_LINE =
  'You are Mera, made by Mera. Never say another company made you or name the AI model. You open no pages.';

/** The on-device article prompts have room for the reason, in short form. */
export const PUBLISHERS_LINE = 'Publishers own their articles, so Mera links out to them.';
