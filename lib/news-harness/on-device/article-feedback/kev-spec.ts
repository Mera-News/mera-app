// Article chat on "Kev decides, the built-in model writes" (D38-D41). Kev
// reads the intent and, for less or more, which matched topic (replacing the
// old silent first-topic fallback). The built-in model writes the reply, the
// story options or the change's effect line. The acts are the cloud chat's
// executors via articleFeedbackTurn. Pure and RN-free.

import type { DecisionChoiceAnswer, DecisionChoiceQuestion } from 'llama.rn';
import type { JsonSchema } from '@/lib/mera-protocol-toolkit/core/structured-json';
import {
  askIfUnsure,
  classifyConsent,
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
import { TRACK_OPTION_RULES } from '../follow-story/prompt';
import { TRACK_OPTIONS_SCHEMA, type TrackOptionReply } from '../follow-story/schema';
import { IDENTITY_LINE, languageLine, text } from '../shared';
import { articleFeedbackTurn } from './parse';
import { articleChatContext, type ArticleChatContext } from './prompt';
import type { ArticleIntent } from './schema';

export const ARTICLE_KEV_INTENTS = [
  'answer_question',
  'follow_story',
  'see_less',
  'see_more',
  'mute_source',
  'agree_to_card',
  'decline_card',
] as const;
export type ArticleKevIntent = (typeof ARTICLE_KEV_INTENTS)[number];

const INTENT_CRITERIA: Record<ArticleKevIntent, string> = {
  answer_question: 'asks a question about the article: what happened, whether it is true, what is new, or why Mera showed it',
  follow_story: 'asks to follow this story and get updates on it',
  see_less: 'wants fewer articles on this subject, or on one of matched_topics',
  see_more: 'wants more articles on this subject, or on one of matched_topics',
  mute_source: 'wants nothing more from this publication or website',
  agree_to_card: 'agrees to the change on the waiting card',
  decline_card: 'declines the change on the waiting card',
};

const INTENT_LABEL_KEYS: Record<ArticleKevIntent, string> = {
  answer_question: 'kevChat.article.answer',
  follow_story: 'kevChat.article.follow',
  see_less: 'kevChat.article.less',
  see_more: 'kevChat.article.more',
  mute_source: 'kevChat.article.mute',
  agree_to_card: 'kevChat.card.agree',
  decline_card: 'kevChat.card.decline',
};

/** The single-call intents the executors map from. */
const ACT: Record<ArticleKevIntent, ArticleIntent> = {
  answer_question: 'answer',
  follow_story: 'track',
  see_less: 'less',
  see_more: 'more',
  mute_source: 'mute',
  agree_to_card: 'confirm',
  decline_card: 'cancel',
};

/** The same six topics the single-call prompt shows. */
const MAX_TOPICS = 6;

export interface ArticleKevInput {
  context: ArticleChatContext;
  /** The waiting card is answered by a tap only (story options, choose-one). */
  pendingTapOnly: boolean;
  languageName?: string;
}

interface DecideInput extends ArticleKevInput {
  message: string;
  conversation: ReturnType<typeof conversationState>;
}

const topics = (input: ArticleKevInput) => input.context.matchedTopics.slice(0, MAX_TOPICS);

function intentKeys(input: ArticleKevInput): ArticleKevIntent[] {
  const c = input.context;
  return ARTICLE_KEV_INTENTS.filter((k) => {
    if (k === 'mute_source') return Boolean(c.publication);
    if (k === 'agree_to_card') return c.pending != null && !input.pendingTapOnly;
    if (k === 'decline_card') return c.pending != null;
    return true;
  });
}

function state(input: DecideInput) {
  const c = input.context;
  return {
    article: {
      title: c.title,
      ...(c.publication ? { publication: c.publication } : {}),
      ...(c.description ? { description: c.description.slice(0, 300) } : {}),
    },
    matched_topics: topics(input),
    ...(c.alreadyFollowing ? { already_following: true } : {}),
    ...(c.pending ? { card_waiting: c.pending } : {}),
    conversation: input.conversation,
    user_message: input.message,
  };
}

export const articleIntentSpec: DecisionSpec<
  DecideInput,
  DecisionChoiceAnswer<ArticleKevIntent>,
  { intent: DecisionChoiceQuestion<ArticleKevIntent> }
> = {
  state,
  questions: (input) => ({
    intent: {
      type: 'choice',
      instructions: 'What does the user want Mera to do with user_message about this article?',
      criteria: Object.fromEntries(intentKeys(input).map((k) => [k, INTENT_CRITERIA[k]])) as Record<ArticleKevIntent, string>,
    },
  }),
  read: (answers) => answers.intent,
};

/** Topic keys t1..tN in shown order. */
const topicKey = (i: number) => `t${i + 1}`;

export const articleTopicSpec: DecisionSpec<
  DecideInput & { intent: 'see_less' | 'see_more' },
  DecisionChoiceAnswer,
  { topic: DecisionChoiceQuestion }
> = {
  state,
  questions: (input) => ({
    topic: {
      type: 'choice',
      instructions:
        input.intent === 'see_less'
          ? 'Which of the matched topics does the user want less of?'
          : 'Which of the matched topics does the user want more of?',
      criteria: Object.fromEntries(topics(input).map((t, i) => [topicKey(i), t])),
    },
  }),
  read: (answers) => answers.topic,
};

const REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { reply: { type: 'string', description: 'One or two short sentences for the user' } },
  required: ['reply'],
};
const CHANGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One or two short sentences for the user' },
    expected_effects: { type: 'string', description: 'One short sentence on what changes in the feed' },
  },
  required: ['reply', 'expected_effects'],
};
const FOLLOW_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One short line asking the user to pick a story below' },
    options: TRACK_OPTIONS_SCHEMA,
  },
  required: ['reply', 'options'],
};

const TASK: Record<ArticleKevIntent, string> = {
  answer_question:
    'Explain why it was suggested, or answer from what you see. Fact checks and web searches need Private cloud, so say that if asked.',
  follow_story: 'Give 3 or 4 options to follow this story, following the option rules, using names from the article.',
  see_less: 'A card asks the user to confirm seeing less of the topic. Point to the card and say what changes.',
  see_more: 'A card asks the user to confirm seeing more of the topic. Point to the card and say what changes.',
  mute_source: 'A card asks the user to confirm muting this publication. Point to the card.',
  agree_to_card: 'The waiting change is being applied now. Confirm it in one short sentence.',
  decline_card: 'The waiting change was dropped. Say so in one short sentence.',
};

const ALREADY_FOLLOWING_TASK = 'The user already follows this story, so nothing changes. Say so in one short sentence.';

function writerSystem(task: string, languageName?: string): string {
  return `${IDENTITY_LINE}
The user is asking about one news article Mera suggested. You see only its title, publication and a short description, never the full text.
${task}
${languageLine(languageName)}`;
}

/** One article chat turn: decide, rules, explain, write, act. Throws only when Kev itself fails. */
export async function runArticleKevTurn(
  input: ArticleKevInput,
  messages: readonly KevMessage[],
  ports: KevPorts,
): Promise<KevTurnResult> {
  const chat = readChat(messages);
  const trace = newTrace();
  const shown = topics(input);
  const base: DecideInput = { ...input, message: chat.subject, conversation: conversationState(chat.earlier) };
  const facts = { matchedTopics: shown, publication: input.context.publication ?? null, hasPending: input.context.pending != null };
  const done = (intent: ArticleKevIntent, reply: string, calls: KevTurnResult['calls'] = []): KevTurnResult => {
    trace.intent = trace.intent || intent;
    return { reply, calls, trace };
  };

  // --- Decide ---------------------------------------------------------------
  let intent: ArticleKevIntent | null = null;
  let tapTopic: string | null = null;
  const lines: string[] = [];
  if (chat.tap) {
    // `intent` or `intent:<topic text>`: the text, so a changed topic list cannot shift it.
    const sep = chat.tap.indexOf(':');
    const tapIntent = (sep === -1 ? chat.tap : chat.tap.slice(0, sep)) as ArticleKevIntent;
    if ((ARTICLE_KEV_INTENTS as readonly string[]).includes(tapIntent)) {
      intent = tapIntent;
      tapTopic = sep === -1 ? null : chat.tap.slice(sep + 1);
      trace.source = 'tap';
    }
  }
  if (!intent && input.context.pending) {
    const consent = classifyConsent(chat.subject);
    if (consent !== 'none') trace.source = 'rule';
    if (consent === 'apply') {
      if (input.pendingTapOnly) return done('agree_to_card', ports.t('kevChat.reply.pickOnCard'));
      intent = 'agree_to_card';
    } else if (consent === 'decline') intent = 'decline_card';
    else if (consent === 'acknowledge') intent = 'answer_question';
  }
  if (!intent) {
    const run = await timedDecide(trace, () => runDecision(articleIntentSpec, base, ports.decide));
    const keys = Object.keys(run.questions.intent.criteria) as ArticleKevIntent[];
    trace.intent = top(run.decision, keys)?.key ?? 'answer_question';
    const labels = Object.fromEntries(keys.map((k) => [k, ports.t(INTENT_LABEL_KEYS[k])]));
    const ask = askIfUnsure(run.decision, labels, ports.t('kevChat.askIntent'));
    if (ask) {
      trace.asked = true;
      return done(trace.intent as ArticleKevIntent, ports.t('kevChat.askIntent'), [ask]);
    }
    const veto = vetoNegatedAgree(trace.intent, chat.subject, run.decision, labels, ports.t('kevChat.askIntent'));
    if (veto) {
      trace.asked = veto.length > 0;
      return done(trace.intent as ArticleKevIntent, ports.t('kevChat.askIntent'), veto);
    }
    intent = trace.intent as ArticleKevIntent;
    lines.push(formatDecision(run.questions, run.answers, { labels: { intent: 'What the user wants' } }));
  } else {
    lines.push(`What the user wants: ${INTENT_CRITERIA[intent]}`);
  }
  trace.intent = trace.intent || intent;

  // --- Which topic, for less or more ---------------------------------------
  let topic: string | null = null;
  if (intent === 'see_less' || intent === 'see_more') {
    const which = intent;
    if (tapTopic && shown.includes(tapTopic)) topic = tapTopic;
    else if (shown.length === 1) topic = shown[0];
    else if (shown.length > 1) {
      const run = await timedDecide(trace, () => runDecision(articleTopicSpec, { ...base, intent: which }, ports.decide));
      const labels = Object.fromEntries(shown.map((t) => [`${which}:${t}`, t]));
      const scoped = {
        probabilities: Object.fromEntries(
          Object.entries(run.decision.probabilities).flatMap(([k, p]) => {
            const t = shown[Number(k.slice(1)) - 1];
            return t ? [[`${which}:${t}`, p]] : [];
          }),
        ),
      };
      const ask = askIfUnsure(scoped, labels, ports.t('kevChat.askTopic'));
      if (ask) {
        trace.asked = true;
        return done(intent, ports.t('kevChat.askTopic'), [ask]);
      }
      const best = top(run.decision, Object.keys(run.questions.topic.criteria));
      topic = best ? shown[Number(best.key.slice(1)) - 1] ?? null : null;
      lines.push(formatDecision(run.questions, run.answers, { labels: { topic: 'The topic they mean' } }));
    }
    if (topic && topic === tapTopic) lines.push(`The topic they mean: ${topic}`);
  }

  // --- Explain, write, act ---------------------------------------------------
  // Follow stays an option once the story is followed: left out, Kev read "follow this"
  // as the next best act (more of this). It now gets a reply and stages nothing.
  if (intent === 'follow_story' && input.context.alreadyFollowing) {
    const value = await write<{ reply?: string }>(ports, trace, {
      system: writerSystem(ALREADY_FOLLOWING_TASK, input.languageName),
      schema: REPLY_SCHEMA,
      context: `${decisionBlock(lines.join('\n'))}\n\n${articleChatContext(input.context)}`,
      history: chat.history,
    });
    trace.intent = 'answer_question'; // the act: an answer, nothing staged
    return done('answer_question', replyOr(value, ports.t('kevChat.reply.chat')));
  }
  // Less or more with no matched topic stages nothing: the old first-topic guess is gone.
  const noTopic = (intent === 'see_less' || intent === 'see_more') && !topic;
  const task = noTopic ? TASK.answer_question : TASK[intent];
  const schema = noTopic ? REPLY_SCHEMA : intent === 'follow_story' ? FOLLOW_SCHEMA : intent === 'see_less' || intent === 'see_more' ? CHANGE_SCHEMA : REPLY_SCHEMA;
  const optionRules = intent === 'follow_story' ? `Option rules: ${TRACK_OPTION_RULES}\n\n` : '';
  const value = await write<{ reply?: string; expected_effects?: string; options?: TrackOptionReply[] }>(ports, trace, {
    system: writerSystem(task, input.languageName),
    schema,
    context: `${optionRules}${decisionBlock(lines.join('\n'))}\n\n${articleChatContext(input.context)}`,
    history: chat.history,
  });

  if (noTopic) return done(intent, replyOr(value, ports.t('kevChat.reply.chat')));
  if (intent === 'follow_story' && !value) return done(intent, ports.t('kevChat.reply.followFailed'));
  const fallback =
    intent === 'agree_to_card'
      ? 'kevChat.reply.applied'
      : intent === 'decline_card'
        ? 'kevChat.reply.cancelled'
        : intent === 'answer_question'
          ? 'kevChat.reply.chat'
          : intent === 'follow_story'
            ? 'kevChat.reply.followFailed'
            : 'kevChat.reply.changeCard';
  const reply = replyOr(value, ports.t(fallback));
  const turn = articleFeedbackTurn(
    {
      intent: ACT[intent],
      reply,
      options: value?.options,
      ...(topic ? { change: { topicText: topic, expected_effects: text(value?.expected_effects) || reply } } : {}),
    },
    facts,
  );
  // "Pick a story below" with no options under it would point at nothing.
  if (intent === 'follow_story' && turn.calls.length === 0) return done(intent, ports.t('kevChat.reply.followFailed'));
  return done(intent, turn.reply, turn.calls);
}
