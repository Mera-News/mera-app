// Follow-story chat on "Kev decides, the built-in model writes" (D38-D41).
// Kev reads the intent only (there is no second question); the built-in model
// writes the story options with the existing schema. Pure and RN-free.

import type { DecisionChoiceAnswer, DecisionChoiceQuestion } from 'llama.rn';
import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';
import {
  askIfUnsure,
  classifyConsent,
  collapse,
  conversationState,
  decisionBlock,
  formatDecision,
  newTrace,
  readChat,
  replyOr,
  runDecision,
  timedDecide,
  top,
  vetoNegatedAgree,
  write,
  type DecisionSpec,
  type KevMessage,
  type KevPorts,
  type KevTurnResult,
} from '../kev';
import { languageLine, IDENTITY_LINE } from '../shared';
import { proposeTrackCalls } from './parse';
import { followStoryContext, followStoryInstructions, TRACK_OPTION_RULES } from './prompt';
import { FOLLOW_STORY_SCHEMA, type FollowStoryReply } from './schema';

export const FOLLOW_KEV_INTENTS = [
  'follow_this_story',
  'follow_a_named_story',
  'question_or_other',
  'agree_to_card',
  'decline_card',
] as const;
export type FollowKevIntent = (typeof FOLLOW_KEV_INTENTS)[number];

const INTENT_CRITERIA: Record<FollowKevIntent, string> = {
  follow_this_story: 'wants to follow the story already named earlier in this chat',
  follow_a_named_story: 'names a news story or subject they want to follow',
  question_or_other: 'asks a question or wants something other than following a story',
  agree_to_card: 'agrees to the change on the waiting card',
  decline_card: 'says no to the waiting card without naming another story',
};

const INTENT_LABEL_KEYS: Partial<Record<FollowKevIntent, string>> = {
  follow_a_named_story: 'kevChat.follow.follow',
  question_or_other: 'kevChat.follow.other',
  agree_to_card: 'kevChat.card.agree',
  decline_card: 'kevChat.card.decline',
};

/** Both follows write the same options, so a close call between them is not a reason to ask. */
const SAME_ACT: Partial<Record<FollowKevIntent, FollowKevIntent>> = { follow_this_story: 'follow_a_named_story' };

export interface FollowKevInput {
  /** YYYY-MM-DD. */
  today: string;
  /** The waiting card: its describePending text, and whether only a tap can answer it. */
  pending: { text: string; tapOnly: boolean } | null;
  languageName?: string;
}

interface DecideInput extends FollowKevInput {
  message: string;
  conversation: ReturnType<typeof conversationState>;
}

function intentKeys(input: FollowKevInput): FollowKevIntent[] {
  return FOLLOW_KEV_INTENTS.filter((k) => {
    if (k === 'agree_to_card') return input.pending != null && !input.pending.tapOnly;
    if (k === 'decline_card') return input.pending != null;
    return true;
  });
}

export const followIntentSpec: DecisionSpec<
  DecideInput,
  DecisionChoiceAnswer<FollowKevIntent>,
  { intent: DecisionChoiceQuestion<FollowKevIntent> }
> = {
  state: (input) => ({
    ...(input.pending ? { card_waiting: input.pending.text } : {}),
    conversation: input.conversation,
    user_message: input.message,
  }),
  questions: (input) => ({
    intent: {
      type: 'choice',
      instructions: 'The user is in a chat for following a news story. What do they want with their latest message?',
      criteria: Object.fromEntries(intentKeys(input).map((k) => [k, INTENT_CRITERIA[k]])) as Record<FollowKevIntent, string>,
    },
  }),
  read: (answers) => answers.intent,
};

const REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string', description: 'One or two short sentences for the user' } },
  required: ['reply'],
};

function replySystem(task: string, languageName?: string): string {
  return `${IDENTITY_LINE}
This chat starts following a news story.
${task}
${languageLine(languageName)}`;
}

const TASK: Record<Exclude<FollowKevIntent, 'follow_this_story' | 'follow_a_named_story'>, string> = {
  question_or_other: 'Answer briefly. If they want something other than following a story, say this chat only starts following a story.',
  agree_to_card: 'The waiting change is being applied now. Confirm it in one short sentence.',
  decline_card: 'The waiting change was dropped. Say so in one short sentence.',
};

/** One follow-story turn: decide, rules, explain, write, act. Throws only when Kev itself fails. */
export async function runFollowKevTurn(
  input: FollowKevInput,
  messages: readonly KevMessage[],
  ports: KevPorts,
): Promise<KevTurnResult> {
  const chat = readChat(messages);
  const trace = newTrace();
  const done = (intent: FollowKevIntent, reply: string, calls: KevTurnResult['calls'] = []): KevTurnResult => {
    trace.intent = trace.intent || intent;
    return { reply, calls, trace };
  };

  let intent: FollowKevIntent | null = null;
  let line = '';
  if (chat.tap && (FOLLOW_KEV_INTENTS as readonly string[]).includes(chat.tap)) {
    intent = chat.tap as FollowKevIntent;
    trace.source = 'tap';
  }
  if (!intent && input.pending) {
    const consent = classifyConsent(chat.subject);
    if (consent !== 'none') trace.source = 'rule';
    if (consent === 'apply') {
      if (input.pending.tapOnly) return done('agree_to_card', ports.t('kevChat.reply.pickOnCard'));
      intent = 'agree_to_card';
    } else if (consent === 'decline') intent = 'decline_card';
    else if (consent === 'acknowledge') intent = 'question_or_other';
  }
  if (!intent) {
    const base: DecideInput = { ...input, message: chat.subject, conversation: conversationState(chat.earlier) };
    const run = await timedDecide(trace, () => runDecision(followIntentSpec, base, ports.decide));
    const keys = Object.keys(run.questions.intent.criteria) as FollowKevIntent[];
    trace.intent = top(run.decision, keys)?.key ?? 'question_or_other';
    const labels = Object.fromEntries(
      keys.flatMap((k) => (INTENT_LABEL_KEYS[k] ? [[k, ports.t(INTENT_LABEL_KEYS[k]!)]] : [])),
    ) as Partial<Record<FollowKevIntent, string>>;
    const ask = askIfUnsure(collapse(run.decision, SAME_ACT), labels, ports.t('kevChat.askIntent'));
    if (ask) {
      trace.asked = true;
      return done(trace.intent as FollowKevIntent, ports.t('kevChat.askIntent'), [ask]);
    }
    const veto = vetoNegatedAgree(trace.intent, chat.subject, run.decision, labels, ports.t('kevChat.askIntent'));
    if (veto) {
      trace.asked = veto.length > 0;
      return done(trace.intent as FollowKevIntent, ports.t('kevChat.askIntent'), veto);
    }
    intent = trace.intent as FollowKevIntent;
    // The two follows are one act: a close call between them reads to the writer as
    // "not named yet", and it asks again instead of writing options. Name the act plainly.
    line =
      intent === 'follow_a_named_story'
        ? `What the user wants: follow the story in their latest message: "${chat.subject.slice(0, 200)}"`
        : intent === 'follow_this_story'
          ? `What the user wants: ${INTENT_CRITERIA[intent]}`
        : formatDecision(run.questions, run.answers, { labels: { intent: 'What the user wants' } });
  } else {
    line = `What the user wants: ${INTENT_CRITERIA[intent]}`;
  }
  trace.intent = trace.intent || intent;

  if (intent === 'follow_this_story' || intent === 'follow_a_named_story') {
    // The existing writer: its instructions already ask which story while none is named.
    const value = await write<FollowStoryReply & Record<string, unknown>>(ports, trace, {
      system: followStoryInstructions(input.languageName),
      schema: FOLLOW_STORY_SCHEMA,
      context: `Option rules: ${TRACK_OPTION_RULES}\n\n${decisionBlock(line)}\n\n${followStoryContext({ today: input.today, pending: input.pending?.text ?? null })}`,
      history: chat.history,
    });
    if (!value) return done(intent, ports.t('kevChat.reply.followFailed'));
    return done(intent, replyOr(value, ports.t('kevChat.reply.followFailed')), proposeTrackCalls(value.options));
  }

  const value = await write<{ reply?: string }>(ports, trace, {
    system: replySystem(TASK[intent], input.languageName),
    schema: REPLY_SCHEMA,
    context: `${decisionBlock(line)}\n\n${followStoryContext({ today: input.today, pending: input.pending?.text ?? null })}`,
    history: chat.history,
  });
  if (intent === 'agree_to_card') {
    return done(intent, replyOr(value, ports.t('kevChat.reply.applied')), [{ name: 'applyProposal', input: {} }]);
  }
  if (intent === 'decline_card') {
    return done(intent, replyOr(value, ports.t('kevChat.reply.cancelled')), [{ name: 'cancelProposal', input: {} }]);
  }
  return done(intent, replyOr(value, ports.t('kevChat.reply.chat')));
}
