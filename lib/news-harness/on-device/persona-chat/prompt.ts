import { DEEP_EXAMPLE_QUESTIONS } from '../../prompts/persona-prompts';
import { asUntrusted } from '../../prompts/untrusted-text';
import { IDENTITY_LINE, languageLine, renderPrompt, type ChatTurn } from '../shared';
import type { PersonaSurface } from './schema';

/** Newest facts shown; older ones fall out of the context first. */
const MAX_FACTS = 20;

export function personaChatInstructions(surface: PersonaSurface, languageName?: string): string {
  const task =
    surface === 'ONBOARDING'
      ? 'Learn what news matters to the user, one question at a time.'
      : 'Help the user add, change or remove facts in their news profile.';
  return `${IDENTITY_LINE}
${task} Facts are short statements about where they live, their work, family and interests, which Mera uses to find news for them.
Each turn, write a reply under 200 characters with at most one question, and fill the fields:
- save: each new fact the user just shared, in English, keeping their names and places. Never repeat a known fact. Nothing is saved until the user taps it, so never say saved.${surface === 'CONFIG' ? '\n- delete: ids from Known facts, only when the user asks to remove one or corrects it.' : ''}
- confirm or cancel: true only when a change is waiting and the user agrees or declines.
${languageLine(languageName)}`;
}

export interface PersonaChatContext {
  /** Newest first. */
  facts: { id: string; statement: string; attribute?: string | null }[];
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
