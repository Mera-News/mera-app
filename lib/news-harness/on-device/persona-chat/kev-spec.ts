// Persona chat on "Kev decides, the built-in model writes" (D38-D41). Kev
// reads the intent (and, for a remove or a correction, which saved fact);
// rules override it; the built-in model only writes the words. Every act is a
// card the user taps: facts to save, the Remove / Keep card (D40), a waiting
// change, or chips when Kev is unsure (D39). Pure and RN-free.

import type { DecisionChoiceAnswer, DecisionChoiceQuestion } from 'llama.rn';
import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';
import {
  askCall,
  askIfUnsure,
  classifyConsent,
  collapse,
  conversationState,
  decisionBlock,
  dropKnownFacts,
  formatDecision,
  isKnownFact,
  isUnsure,
  newTrace,
  ranked,
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
import { IDENTITY_LINE, languageLine, text, type OnDeviceToolCall } from '../shared';
import { personaChatContext, type PersonaChatContext } from './prompt';
import type { PersonaSurface } from './schema';

export const PERSONA_INTENTS = [
  'share_new_fact',
  'remove_fact',
  'correct_fact',
  'agree_to_card',
  'decline_card',
  'question_or_chat',
  'thanks_or_ack',
] as const;
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];

const INTENT_CRITERIA: Record<PersonaIntent, string> = {
  share_new_fact:
    'tells Mera something about their own life: where they live, work, family, health, beliefs, plans, hobbies or the news they want',
  remove_fact: 'asks Mera to delete, remove or forget one of the saved_facts',
  correct_fact: 'says one of the saved_facts has changed, and says what it is now',
  agree_to_card: 'agrees to the change on the waiting card',
  decline_card: 'declines the change on the waiting card',
  question_or_chat: 'asks Mera a question or makes small talk, and tells nothing about their own life',
  thanks_or_ack: 'only says thanks, ok or similar',
};

/** Chip text per reading (i18n keys). thanks_or_ack has none: it merges into chatting. */
const INTENT_LABEL_KEYS: Partial<Record<PersonaIntent, string>> = {
  share_new_fact: 'kevChat.persona.share',
  remove_fact: 'kevChat.persona.remove',
  correct_fact: 'kevChat.persona.correct',
  agree_to_card: 'kevChat.card.agree',
  decline_card: 'kevChat.card.decline',
  question_or_chat: 'kevChat.persona.chat',
};

/** Both only reply, so a close call between them is not a reason to ask. */
const SAME_ACT: Partial<Record<PersonaIntent, PersonaIntent>> = { thanks_or_ack: 'question_or_chat' };

/** ponytail: the plan's fixed floor; every fact at or above it goes on the Remove / Keep card. Tune on dev. */
export const DELETE_CARD_MIN_P = 0.25;
/** The same window the single-call prompt shows. */
const MAX_FACTS = 20;
const NONE = 'none';

export interface PersonaKevInput {
  surface: PersonaSurface;
  /** Newest first. */
  facts: PersonaChatContext['facts'];
  topicPlanNotes?: string | null;
  /** The waiting card: its describePending text, and whether only a tap can answer it. */
  pending: { text: string; tapOnly: boolean } | null;
  languageName?: string;
}

interface IntentInput extends PersonaKevInput {
  message: string;
  conversation: ReturnType<typeof conversationState>;
}

function shownFacts(input: PersonaKevInput) {
  return input.facts.slice(0, MAX_FACTS);
}

function intentKeys(input: PersonaKevInput): PersonaIntent[] {
  const canEdit = input.surface === 'CONFIG' && shownFacts(input).length > 0;
  return PERSONA_INTENTS.filter((k) => {
    if (k === 'remove_fact' || k === 'correct_fact') return canEdit;
    if (k === 'agree_to_card') return input.pending != null && !input.pending.tapOnly;
    if (k === 'decline_card') return input.pending != null;
    return true;
  });
}

function state(input: IntentInput) {
  return {
    saved_facts: shownFacts(input).map((f) => f.statement),
    ...(input.pending ? { card_waiting: input.pending.text } : {}),
    conversation: input.conversation,
    user_message: input.message,
  };
}

export const personaIntentSpec: DecisionSpec<
  IntentInput,
  DecisionChoiceAnswer<PersonaIntent>,
  { intent: DecisionChoiceQuestion<PersonaIntent> }
> = {
  state,
  questions: (input) => ({
    intent: {
      type: 'choice',
      instructions: 'What does the user want Mera to do with user_message?',
      criteria: Object.fromEntries(intentKeys(input).map((k) => [k, INTENT_CRITERIA[k]])) as Record<PersonaIntent, string>,
    },
  }),
  read: (answers) => answers.intent,
};

/** Fact keys are f1..fN in shown order, never the real ids (numbers would sort first). */
const factKey = (i: number) => `f${i + 1}`;

export const personaTargetSpec: DecisionSpec<
  IntentInput & { intent: 'remove_fact' | 'correct_fact' },
  DecisionChoiceAnswer,
  { target: DecisionChoiceQuestion }
> = {
  state,
  questions: (input) => ({
    target: {
      type: 'choice',
      instructions:
        input.intent === 'remove_fact'
          ? 'Which saved fact does the user want removed?'
          : 'Which saved fact does the user say has changed?',
      criteria: {
        ...Object.fromEntries(shownFacts(input).map((f, i) => [factKey(i), f.statement])),
        [NONE]: 'none of these facts',
      },
    },
  }),
  read: (answers) => answers.target,
};

const SAVE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'One short fact in English' },
          attribute: { type: 'string', description: 'A short label, category: detail' },
        },
        required: ['statement', 'attribute'],
      },
    },
    reply: { type: 'string', description: 'Under 200 characters, at most one question' },
  },
  required: ['facts', 'reply'],
};
const CORRECT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    statement: { type: 'string', description: 'The fact as it is now, one short statement in English' },
    reply: { type: 'string', description: 'Under 200 characters' },
  },
  required: ['statement', 'reply'],
};
const REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string', description: 'Under 200 characters, at most one question' } },
  required: ['reply'],
};

const TASK: Record<PersonaIntent | 'not_found', string> = {
  share_new_fact:
    'Write each new fact the user just shared as a short statement in English, keeping their names and places, with an attribute. Leave out anything the saved facts already say. The user taps to save, so never say saved.',
  correct_fact:
    'Write the fact as it is now, one short statement in English that replaces the quoted fact. The user taps to save, so never say saved.',
  remove_fact: 'A card lists the fact for the user to tap Remove or Keep. Point to the card; never say it is removed.',
  not_found: 'No saved fact matches what the user wants removed. Say you could not find it and name what you hold on that subject.',
  agree_to_card: 'The waiting change is being applied now. Confirm it in one short sentence.',
  decline_card: 'The waiting change was dropped. Say so in one short sentence.',
  question_or_chat: 'Answer the user or chat briefly. Do not offer to save anything.',
  thanks_or_ack: 'The user only acknowledged. Reply briefly and warmly.',
};

function writerSystem(task: string, languageName?: string): string {
  return `${IDENTITY_LINE}
You help the user keep a news profile: short facts about where they live, their work, family and interests.
${task}
Keep the reply under 200 characters with at most one question.
${languageLine(languageName)}`;
}

/** One persona chat turn: decide, rules, explain, write, act. Throws only when Kev itself fails. */
export async function runPersonaKevTurn(
  input: PersonaKevInput,
  messages: readonly KevMessage[],
  ports: KevPorts,
): Promise<KevTurnResult> {
  const chat = readChat(messages);
  const trace = newTrace();
  const facts = shownFacts(input);
  const known = input.facts.map((f) => f.statement);
  const base: IntentInput = { ...input, message: chat.subject, conversation: conversationState(chat.earlier) };
  const labels = (keys: PersonaIntent[]) =>
    Object.fromEntries(keys.flatMap((k) => (INTENT_LABEL_KEYS[k] ? [[k, ports.t(INTENT_LABEL_KEYS[k]!)]] : []))) as Partial<
      Record<PersonaIntent, string>
    >;
  const done = (intent: string, reply: string, calls: OnDeviceToolCall[] = []): KevTurnResult => {
    trace.intent = trace.intent || intent;
    return { reply, calls, trace };
  };

  // --- Decide (a tap or consent words first: both skip Kev) ---------------
  let intent: PersonaIntent | null = null;
  let tapTarget: string | null = null;
  const lines: string[] = [];
  if (chat.tap) {
    // `intent` or `intent:<fact id>`: the real id, so a fact saved between the ask and the tap cannot shift it.
    const sep = chat.tap.indexOf(':');
    const tapIntent = (sep === -1 ? chat.tap : chat.tap.slice(0, sep)) as PersonaIntent;
    if ((PERSONA_INTENTS as readonly string[]).includes(tapIntent)) {
      intent = tapIntent;
      tapTarget = sep === -1 ? null : chat.tap.slice(sep + 1);
      trace.source = 'tap';
    }
  }
  if (!intent && input.pending) {
    const consent = classifyConsent(chat.subject);
    if (consent !== 'none') trace.source = 'rule';
    if (consent === 'apply') {
      if (input.pending.tapOnly) return done('agree_to_card', ports.t('kevChat.reply.pickOnCard'));
      intent = 'agree_to_card';
    } else if (consent === 'decline') intent = 'decline_card';
    else if (consent === 'acknowledge') intent = 'thanks_or_ack';
  }
  if (!intent) {
    const run = await timedDecide(trace, () => runDecision(personaIntentSpec, base, ports.decide));
    const answer = run.decision;
    const keys = Object.keys(run.questions.intent.criteria) as PersonaIntent[];
    // Unsure is judged with the reply-only readings merged; the act uses Kev's own top reading.
    const merged = collapse(answer, SAME_ACT);
    trace.intent = top(answer, keys)?.key ?? 'question_or_chat';
    const ask = askIfUnsure(merged, labels(keys), ports.t('kevChat.askIntent'));
    if (ask) {
      trace.asked = true;
      return done(trace.intent, ports.t('kevChat.askIntent'), [ask]);
    }
    const veto = vetoNegatedAgree(trace.intent, chat.subject, answer, labels(keys), ports.t('kevChat.askIntent'));
    if (veto) {
      trace.asked = veto.length > 0;
      return done(trace.intent, ports.t('kevChat.askIntent'), veto);
    }
    intent = trace.intent as PersonaIntent;
    lines.push(formatDecision(run.questions, run.answers, { labels: { intent: 'What the user wants' } }));
  } else {
    lines.push(`What the user wants: ${INTENT_CRITERIA[intent]}`);
  }

  // --- The target fact, for a remove or a correction ----------------------
  let targets: typeof facts = [];
  if (intent === 'remove_fact' || intent === 'correct_fact') {
    const which = intent;
    let answer: Pick<DecisionChoiceAnswer, 'probabilities'>;
    // A tapped fact that is gone since the ask is asked about again.
    const tapped = tapTarget ? facts.findIndex((f) => f.id === tapTarget) : -1;
    if (tapped !== -1) {
      answer = { probabilities: { [factKey(tapped)]: 1 } };
      lines.push(`The fact they mean: "${facts[tapped].statement}"`);
    } else {
      const run = await timedDecide(trace, () => runDecision(personaTargetSpec, { ...base, intent: which }, ports.decide));
      answer = run.decision;
      lines.push(formatDecision(run.questions, run.answers, { labels: { target: 'The fact they mean' }, quote: ['target'] }));
    }
    const factAt = (key: string) => (/^f\d+$/.test(key) ? facts[Number(key.slice(1)) - 1] : undefined);
    const best = top(answer);
    const factLabels = Object.fromEntries(facts.map((f) => [`${which}:${f.id}`, f.statement])) as Record<string, string>;
    const askFact = () => {
      // The chips carry intent and fact id, so a tap needs no second Kev call.
      const scoped = {
        probabilities: Object.fromEntries(
          ranked(answer).flatMap((r) => {
            const f = factAt(r.key);
            return f ? [[`${which}:${f.id}`, r.p]] : [];
          }),
        ),
      };
      return askCall(scoped, factLabels, ports.t('kevChat.askFact'));
    };
    const noneSure = best?.key === NONE && !isUnsure(answer);
    if (which === 'remove_fact') {
      targets = ranked(answer).filter((r) => r.key !== NONE && r.p >= DELETE_CARD_MIN_P).flatMap((r) => factAt(r.key) ?? []);
      if (targets.length === 0 && !noneSure) {
        const ask = askFact();
        if (ask) {
          trace.asked = true;
          return done(intent, ports.t('kevChat.askFact'), [ask]);
        }
      }
    } else {
      const fact = best && !isUnsure(answer) ? factAt(best.key) : undefined;
      if (fact) targets = [fact];
      else if (noneSure) intent = 'share_new_fact'; // nothing on file changed: it is new
      else {
        const ask = askFact();
        if (ask) {
          trace.asked = true;
          return done(intent, ports.t('kevChat.askFact'), [ask]);
        }
        intent = 'share_new_fact';
      }
    }
  }
  trace.intent = trace.intent || intent;

  // --- Explain, write, act -------------------------------------------------
  const task = intent === 'remove_fact' && targets.length === 0 ? 'not_found' : intent;
  const context = `${decisionBlock(lines.join('\n'))}\n\n${personaChatContext(input.surface, {
    facts: input.facts,
    topicPlanNotes: input.topicPlanNotes,
    pending: input.pending?.text ?? null,
  })}`;
  const schema = intent === 'share_new_fact' ? SAVE_SCHEMA : intent === 'correct_fact' ? CORRECT_SCHEMA : REPLY_SCHEMA;
  const value = await write<{ reply?: string; facts?: { statement?: string; attribute?: string }[]; statement?: string }>(ports, trace, {
    system: writerSystem(TASK[task], input.languageName),
    schema,
    context,
    history: chat.history,
  });

  switch (intent) {
    case 'share_new_fact': {
      if (!value) return done(intent, ports.t('kevChat.reply.saveFailed'));
      const wrote = (value.facts ?? []).map((f) => ({ statement: text(f?.statement), attribute: text(f?.attribute) }));
      const fresh = dropKnownFacts(wrote, known);
      if (fresh.length === 0) {
        return done(intent, wrote.length > 0 ? ports.t('kevChat.reply.alreadyKnown') : replyOr(value, ports.t('kevChat.reply.chat')));
      }
      // A card goes out with these facts, so an empty reply points at it
      // instead of saying nothing was caught.
      return done(intent, replyOr(value, ports.t('kevChat.reply.changeCard')), [
        {
          name: 'saveExtractedFacts',
          input: {
            extracted_user_information: fresh.map((f) => ({ statement: f.statement, questionnaire_attribute: f.attribute || 'other' })),
          },
        },
      ]);
    }
    case 'correct_fact': {
      const old = targets[0];
      const statement = text(value?.statement);
      if (!statement) return done(intent, ports.t('kevChat.reply.saveFailed'));
      if (isKnownFact(statement, known)) return done(intent, ports.t('kevChat.reply.alreadyKnown'));
      return done(intent, replyOr(value, ports.t('kevChat.reply.changeCard')), [
        {
          name: 'saveExtractedFacts',
          // `replaces`: the tap on the new fact swaps it for the old one in one
          // transaction. Nothing is removed until that tap (D40).
          input: {
            extracted_user_information: [{ statement, questionnaire_attribute: old.attribute || 'other', replaces: old.id }],
          },
        },
      ]);
    }
    case 'remove_fact':
      if (targets.length === 0) return done(intent, replyOr(value, ports.t('kevChat.reply.notFound')));
      return done(intent, replyOr(value, ports.t('kevChat.reply.removeCard')), [
        { name: 'deleteUserFacts', input: { fact_ids: targets.map((f) => f.id) } },
      ]);
    case 'agree_to_card':
      return done(intent, replyOr(value, ports.t('kevChat.reply.applied')), [{ name: 'applyProposal', input: {} }]);
    case 'decline_card':
      return done(intent, replyOr(value, ports.t('kevChat.reply.cancelled')), [{ name: 'cancelProposal', input: {} }]);
    case 'thanks_or_ack':
      return done(intent, replyOr(value, ports.t('kevChat.reply.ack')));
    default:
      return done(intent, replyOr(value, ports.t('kevChat.reply.chat')));
  }
}
