import { buildTutorialHelpContext } from '../../tutorial-help';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';

export function tutorialHelpInstructions(languageName?: string): string {
  return `${IDENTITY_LINE}
The user is reading a short guide inside the Mera app and asked a question about it. Explain how Mera works in plain, warm words, in at most 3 short sentences, without lists.
You cannot change anything: never say or imply that you changed a setting, a fact, the feed or a followed story. If they want a change, tell them where in the app to make it.
If you are not sure, say so in one sentence and point them to Settings, then FAQ.
Never say persona, embedding, vector, cluster or model to the user.
${languageLine(languageName)}`;
}

/** What the guide answer must never get wrong; sent as the prompt, not the instructions. */
const FACTS = `Facts:
- The default is Private cloud, with encrypted processing. On this phone is a setting the user can switch on.
- The user's facts, interests and reading history stay on their phone. What leaves is short topic phrases with no user ID, plus their email and plan.
- Mera has no decoy or noise feature today. It is a planned part of the Mera Protocol that is still being built.
- In the Feed nothing is removed: a story the user has read moves below a divider and stays readable.
- A thumbs up or down with no reason is discarded; the reason is what changes anything.
- Muting a source keeps it out entirely; the down arrow only makes it rarer.`;

export function buildTutorialHelpOnDevicePrompt(route: string | null | undefined, history: readonly ChatTurn[], budgetTokens: number): string {
  const where = buildTutorialHelpContext(route).replace(/<\/?context>/g, '').trim();
  return renderPrompt(`${FACTS}\n\n${where}`, history, budgetTokens);
}
