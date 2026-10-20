import { proposeTrackCalls } from '../follow-story/parse';
import { text, type OnDeviceToolCall, type OnDeviceTurnResult } from '../shared';
import type { ArticleFeedbackReply } from './schema';

/** A small step either way; the executor clamps to its own limit. */
const TOPIC_WEIGHT_STEP = 0.3;

export interface ArticleTurnFacts {
  /** The article's topics that matched the user, as shown in the context. */
  matchedTopics: string[];
  /** The article's publication name, for a mute. */
  publication: string | null;
  /** Whether a card is waiting on the user. */
  hasPending: boolean;
}

/** The model's topic when it is one of the matched topics, else the first matched topic. */
function pickTopic(raw: string, matched: string[]): string | null {
  const wanted = raw.toLowerCase();
  return matched.find((t) => t.toLowerCase() === wanted) ?? matched[0] ?? null;
}

/**
 * Each intent to the executors the cloud chat calls: proposeTrack, proposeChanges
 * (which stages a card), applyProposal and cancelProposal. Anything the reply
 * cannot back (no matched topic, no publication, no pending card) stages
 * nothing and leaves just the reply.
 */
export function articleFeedbackTurn(value: ArticleFeedbackReply, facts: ArticleTurnFacts): OnDeviceTurnResult {
  const reply = text(value.reply);
  const change = (actions: Record<string, unknown>[], chooseOne = false): OnDeviceToolCall[] => [
    {
      name: 'proposeChanges',
      input: {
        explanation: reply,
        expected_effects: text(value.change?.expected_effects) || reply,
        ...(chooseOne ? { choose_one: true } : {}),
        actions,
      },
    },
  ];
  const topic = pickTopic(text(value.change?.topicText), facts.matchedTopics);
  let calls: OnDeviceToolCall[] = [];
  switch (value.intent) {
    case 'track':
      calls = proposeTrackCalls(value.options);
      break;
    case 'less':
      if (topic) {
        calls = change(
          [
            { type: 'set_topic_weight', topicText: topic, delta: -TOPIC_WEIGHT_STEP },
            { type: 'retire_topic', topicText: topic },
          ],
          true,
        );
      }
      break;
    case 'more':
      if (topic) calls = change([{ type: 'set_topic_weight', topicText: topic, delta: TOPIC_WEIGHT_STEP }]);
      break;
    case 'mute':
      if (facts.publication) {
        calls = change([{ type: 'set_publication_pref', publicationId: facts.publication, publicationPref: 'mute' }]);
      }
      break;
    case 'confirm':
      if (facts.hasPending) calls = [{ name: 'applyProposal', input: {} }];
      break;
    case 'cancel':
      if (facts.hasPending) calls = [{ name: 'cancelProposal', input: {} }];
      break;
    case 'answer':
      break;
  }
  return { reply, calls };
}
