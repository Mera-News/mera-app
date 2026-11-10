import { DEEP_EXAMPLE_QUESTIONS } from '../../prompts/persona-prompts';
import { asUntrusted } from '../../prompts/untrusted-text';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import type { PersonaSurface } from './schema';
import { DEVICE_SLOTS } from '../../../harnesses/slots';
import { render } from '../../../harnesses/template';

/** Newest facts shown; older ones fall out of the context first. */
const MAX_FACTS = 20;

export function personaChatInstructions(surface: PersonaSurface, languageName?: string): string {
  const onboarding = surface === 'ONBOARDING';
  const isConfig = surface === 'CONFIG';
  const language = languageLine(languageName);
  return render(DEVICE_SLOTS["persona-chat/instructions"], { IDENTITY_LINE, isConfig, language, onboarding });
}

export interface PersonaChatContext {
  /** Newest first. */
  facts: { id: string; statement: string; attribute?: string | null }[];
  /** What the user did with topic-plan cards (formatTopicPlanNotesBlock), if anything. */
  topicPlanNotes?: string | null;
  pending?: string | null;
}

export function personaChatContext(surface: PersonaSurface, c: PersonaChatContext): string {
  const facts = c.facts.slice(0, MAX_FACTS);
  const blocks = [
    `Known facts:\n${
      facts.length > 0
        ? facts
            .map((f) => `- [${f.id}] ${asUntrusted(f.statement, 160)}${f.attribute ? ` (${asUntrusted(f.attribute, 40)})` : ''}`)
            .join('\n')
        : 'None yet.'
    }`,
  ];
  if (c.topicPlanNotes) {
    blocks.push(`Topic plan decisions, already applied, so do not repeat or undo them:\n${c.topicPlanNotes}`);
  }
  if (surface === 'ONBOARDING') {
    blocks.push(`Questions you can ask, skipping any Known facts already answer:\n${DEEP_EXAMPLE_QUESTIONS.map((q) => `- ${q}`).join('\n')}`);
  }
  if (c.pending) blocks.push(c.pending);
  return blocks.join('\n\n');
}

/** The ids the context shows, so a delete can be checked against them. */
export function shownFactIds(c: PersonaChatContext): Set<string> {
  return new Set(c.facts.slice(0, MAX_FACTS).map((f) => f.id));
}

export function buildPersonaChatPrompt(
  surface: PersonaSurface,
  context: PersonaChatContext,
  history: readonly ChatTurn[],
  budgetTokens: number,
): string {
  return renderPrompt(personaChatContext(surface, context), history, budgetTokens);
}
