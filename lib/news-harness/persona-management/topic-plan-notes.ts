// topic-plan-notes — what Mera is told when the user answers a topic-plan card.
//
// PURE and RN-free, like everything else in news-harness: the store holds the
// notes, this module decides what the model reads.
//
// TWO RENDERINGS OF ONE NOTE, and the split is the whole design:
//   - `formatTopicPlanNotesBlock` → a <context> block. STATE, past tense, read
//     fresh on every turn by both engines. This is what a SAVE produces, and it
//     starts no turn.
//   - `buildTopicPlanTurnBody` → the body of a hidden user turn. INSTRUCTION,
//     imperative, self-contained. This is what a DISCARD produces, because the
//     user is owed a reply and <context> alone cannot start one.
//
// The bodies are self-contained rather than pointers into <context> ("see the
// note above") because a 4B on-device model cross-references unreliably.
//
// BUDGET. The on-device turn ABORTS rather than shrinks when the input budget is
// blown (useLocalLLM), so every cap here is load-bearing, not cosmetic.

export interface TopicPlanNote {
  kind: 'saved' | 'discarded';
  /** The fact statement, English as the agent wrote it. */
  statement: string;
  /** SAVE only: topics still active when the user saved. */
  kept?: string[];
  /** SAVE only: topics the user trimmed with the per-row X before saving. */
  removed?: string[];
  at: number;
}

/** Newest notes kept; older ones fall off. Four is enough to explain a session. */
export const MAX_TOPIC_PLAN_NOTES = 4;

/** How many notes the <context> block renders. Lower than the cap because this
 *  one is re-sent on EVERY turn, where the turn body is sent once. */
const MAX_NOTES_IN_CONTEXT = 2;

const MAX_STATEMENT_CHARS = 60;
const MAX_TOPIC_CHARS = 40;
const MAX_TOPICS_LISTED = 3;

function trunc(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function list(topics: string[] | undefined): string {
  if (!topics || topics.length === 0) return '';
  const shown = topics.slice(0, MAX_TOPICS_LISTED).map((x) => trunc(x, MAX_TOPIC_CHARS));
  const extra = topics.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

/**
 * The `<context>` block. Returns `undefined` when there is nothing to say — that
 * is what keeps `buildPersonaContext`'s call args byte-identical for every user
 * who has not answered a card, and the seam tests assert exactly that.
 */
export function formatTopicPlanNotesBlock(notes?: TopicPlanNote[]): string | undefined {
  if (!notes || notes.length === 0) return undefined;

  const recent = notes.slice(-MAX_NOTES_IN_CONTEXT);
  const lines = recent.map((n) => {
    const statement = trunc(n.statement, MAX_STATEMENT_CHARS);
    if (n.kind === 'discarded') {
      return `- REJECTED "${statement}" — the user turned down the topics you generated, and that fact was deleted. Do not save it again unless they ask.`;
    }
    const kept = list(n.kept);
    const removed = list(n.removed);
    const keptPart = kept ? ` — now tracking: ${kept}.` : '.';
    const removedPart = removed ? ` The user removed: ${removed}.` : '';
    return `- KEPT "${statement}"${keptPart}${removedPart}`;
  });

  const hidden = notes.length - recent.length;
  const tail = hidden > 0 ? `\n- (and ${hidden} earlier decision${hidden === 1 ? '' : 's'})` : '';

  return `${lines.join('\n')}${tail}`;
}

/**
 * The hidden user turn's body, sent after a DISCARD.
 *
 * `compact` is the on-device variant: same instruction, a third of the tokens,
 * because that path shares a 3072-token input budget with the whole prompt.
 */
export function buildTopicPlanTurnBody(
  notes: TopicPlanNote[],
  opts: { compact?: boolean } = {},
): string {
  const discarded = notes.filter((n) => n.kind === 'discarded');
  const saved = notes.filter((n) => n.kind === 'saved');
  if (discarded.length === 0) return '';

  const statements = discarded.map((n) => trunc(n.statement, MAX_STATEMENT_CHARS));
  const multi = statements.length > 1;

  if (opts.compact) {
    const subject = multi ? statements.map((s) => `"${s}"`).join(', ') : `"${statements[0]}"`;
    return [
      '[SYSTEM NOTE — not from the user. Do not quote it.]',
      `The user REJECTED the topics you generated for ${subject}. Those facts were deleted; do not save them again.`,
      'Reply with ONE short message asking what they actually want followed. Call saveExtractedFacts with an empty array.',
    ].join('\n');
  }

  const keptLine =
    saved.length > 0
      ? `\nThey KEPT: ${saved.map((n) => `"${trunc(n.statement, MAX_STATEMENT_CHARS)}"`).join(', ')}. Do not re-propose those.`
      : '';

  if (multi) {
    // Rejecting everything at once is a signal about HOW topics are being
    // chosen, not about one bad topic — so this variant asks a question rather
    // than offering replacements, which would be 6-9 options in one bubble.
    return [
      '[SYSTEM NOTE — this is not a message from the user. Do not quote it. Do not thank them for it.]',
      'The user just REJECTED the topics you generated for ALL of these at once:',
      ...statements.map((s) => `- "${s}"`),
      'These facts and their topics have been deleted. Do not re-save them.',
      'They rejected everything together, so the problem is HOW you are choosing topics, not one bad topic.',
      keptLine.trim(),
      '',
      'Reply now with ONE short message (under 200 characters): ask ONE question about what they want followed — narrower topics, broader ones, or a different aspect entirely. Do NOT offer replacement topics yet.',
      'Call saveExtractedFacts with an empty array — save nothing on this turn.',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  return [
    '[SYSTEM NOTE — this is not a message from the user. Do not quote it. Do not thank them for it.]',
    `The user just REJECTED the topics you generated for: "${statements[0]}".`,
    'That fact and its topics have been deleted. Do not re-save the same fact.',
    keptLine.trim(),
    '',
    'Reply now with ONE short message (under 200 characters) doing exactly one of:',
    '(a) offer 2-3 clearly DIFFERENT angles on the same interest, or',
    '(b) ask ONE short question about what they actually want followed.',
    'Do not apologise more than once. Do not list the rejected topics back to them.',
    'Call saveExtractedFacts with an empty array — save nothing on this turn.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
