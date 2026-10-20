// On-device article chat: one intent per turn, run through the cloud agent's
// own executors (already-following guard, choose-one refusal and all).

import type { FeedbackSubject } from '../../../../components/custom/cards/feedback-subject';
import {
  ARTICLE_FEEDBACK_SCHEMA,
  articleFeedbackInstructions,
  articleFeedbackTurn,
  buildArticleFeedbackPrompt,
  type ArticleChatContext,
  type ArticleFeedbackReply,
} from '../../../news-harness/on-device/article-feedback';
import { describePending } from '../../../news-harness/on-device/shared';
import type { TrackFeedbackSubject } from '../../../news-harness/core/types';
import { useFloatingChatStore } from '../../../stores/floating-chat-store';
import { isSubjectTracked } from '../../../tracking/track-actions';
import { ArticleFeedbackAgent } from '../ArticleFeedbackAgent';
import type { ConversationMessage, OnDeviceAgent } from '../../types';
import { appLanguageName, chatTurns, respondStructured, today } from './run';

function day(raw: string | null | undefined): string | null {
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? today(ms) : null;
}

export class ArticleFeedbackOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;
  private readonly cloud: ArticleFeedbackAgent;

  constructor(
    userId: string,
    target: { articleId?: string; suggestionId?: string },
    trackSubject?: TrackFeedbackSubject | null,
  ) {
    this.cloud = new ArticleFeedbackAgent(userId, target, trackSubject);
    this.id = this.cloud.id;
  }

  private async context(): Promise<ArticleChatContext> {
    const [ctx, relatedCoverage] = await Promise.all([this.cloud.loadArticleContext(), this.cloud.getRelatedCoverage()]);
    const store = useFloatingChatStore.getState();
    const chat = store.context.kind === 'article-suggestion' ? store.context : null;
    const subject = this.cloud.resolveTrackSubject();
    let alreadyFollowing = false;
    if (subject) alreadyFollowing = await isSubjectTracked(subject as FeedbackSubject).catch(() => false);
    const s = ctx?.suggestion;
    return {
      today: today(),
      published: day(subject?.pubDate),
      title: s?.title_en ?? s?.title_original ?? chat?.articleTitle ?? '(untitled)',
      publication: s?.publication_name ?? null,
      description: s?.description_en ?? null,
      category: ctx?.category ?? null,
      entities: ctx?.entities ?? [],
      relevance: s?.isScored ? s.relevance : null,
      note: s?.reason ?? null,
      matchedTopics: ctx?.matchedTopicTexts ?? [],
      producingFacts: (ctx?.linkedFacts ?? []).map((f) => f.statement),
      relatedCoverage,
      alreadyFollowing,
      verdict: chat?.verdict ?? null,
      pending: describePending(store.proposal),
    };
  }

  async respond(messages: ConversationMessage[]) {
    const context = await this.context();
    const value = await respondStructured<ArticleFeedbackReply>(
      articleFeedbackInstructions(appLanguageName()),
      ARTICLE_FEEDBACK_SCHEMA,
      (budget) => buildArticleFeedbackPrompt(context, chatTurns(messages), budget),
    );
    return articleFeedbackTurn(value, {
      matchedTopics: context.matchedTopics.slice(0, 6),
      publication: context.publication ?? null,
      hasPending: context.pending != null,
    });
  }

  executeTool(name: string, input: unknown) {
    return this.cloud.executeTool(name, input);
  }
}
