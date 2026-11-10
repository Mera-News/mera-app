import { buildTutorialHelpContext } from '../../tutorial-help';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import { DEVICE_BASE_SLOTS } from '../../../harnesses/slots.generated';
import { render } from '../../../harnesses/template';

export function tutorialHelpInstructions(languageName?: string): string {
  const language = languageLine(languageName);
  return render(DEVICE_BASE_SLOTS["tutorial-help/instructions"], { IDENTITY_LINE, language });
}

/** What the guide answer must never get wrong; sent as the prompt, not the instructions. */
const FACTS = DEVICE_BASE_SLOTS["tutorial-help/facts"];

export function buildTutorialHelpOnDevicePrompt(route: string | null | undefined, history: readonly ChatTurn[], budgetTokens: number): string {
  const where = buildTutorialHelpContext(route).replace(/<\/?context>/g, '').trim();
  return renderPrompt(`${FACTS}\n\n${where}`, history, budgetTokens);
}
