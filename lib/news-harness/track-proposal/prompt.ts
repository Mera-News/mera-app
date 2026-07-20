// news-harness — track-proposal prompt builder (PURE, RN-free).

import { sanitizeForPrompt } from '../prompts/prompts';
import {
  MAX_DESC_CHARS,
  MAX_INSTRUCTION_CHARS,
  MAX_PREV_PROPOSAL_CHARS,
  MAX_PROPOSAL_WORDS,
  MAX_TITLE_CHARS,
} from './config';
import type { TrackProposalInput, TrackProposalPrompt } from './types';

/** System prompt: propose what ongoing topic to follow, phrased durably, strict
 *  JSON. Kept terse to protect the token budget. English-canonical (rendered
 *  via TranslatableDynamic downstream). */
export const TRACK_PROPOSAL_SYSTEM_PROMPT =
  `You help a reader FOLLOW an unfolding news story. Given one article they tapped "Track" on, propose in ONE sentence what to keep following — as a durable, ongoing topic, not a restatement of this single article.

Rules:
- ONE sentence, ${MAX_PROPOSAL_WORDS} words or fewer, phrased as a trackable topic.
- Describe the CONTINUING story (the protest, the trial, the negotiation, the outbreak…), not the specific update that sparked the interest, so future developments about it also match.
- Include the concrete anchors that keep it specific: who / what / where. Do not invent details absent from the article.
- Plain, neutral language. No clickbait, no ALL CAPS, no trailing punctuation gimmicks.
- If the reader gives an instruction to change the focus, follow it and re-scope the topic accordingly.

Output ONLY a JSON object, nothing else:
{"track": "Updates on the student protest in Sonbhadra over exam results"}`;

/**
 * Build the {system, user} pair for one track-proposal call. Inputs are
 * sanitized + truncated. On a revision round (previousProposal + instruction
 * present) the prior proposal and the user's instruction are appended so the
 * model re-scopes rather than starting over.
 */
export function buildTrackProposalPrompt(input: TrackProposalInput): TrackProposalPrompt {
  const title = sanitizeForPrompt(input.title ?? '', MAX_TITLE_CHARS);
  const description =
    typeof input.description === 'string' && input.description.trim()
      ? sanitizeForPrompt(input.description, MAX_DESC_CHARS)
      : '';
  const previousProposal =
    typeof input.previousProposal === 'string' && input.previousProposal.trim()
      ? sanitizeForPrompt(input.previousProposal, MAX_PREV_PROPOSAL_CHARS)
      : '';
  const userInstruction =
    typeof input.userInstruction === 'string' && input.userInstruction.trim()
      ? sanitizeForPrompt(input.userInstruction, MAX_INSTRUCTION_CHARS)
      : '';

  const lines: string[] = [`Article title: ${title}`];
  if (description) lines.push(`Article summary: ${description}`);
  if (previousProposal) lines.push(`\nYour previous proposal: ${previousProposal}`);
  if (userInstruction) {
    lines.push(
      `The reader wants to track something else: ${userInstruction}\nRevise the topic to match what they asked for.`,
    );
  }
  lines.push('\nPropose what to track now as a JSON object.');

  return { system: TRACK_PROPOSAL_SYSTEM_PROMPT, user: lines.join('\n') };
}
