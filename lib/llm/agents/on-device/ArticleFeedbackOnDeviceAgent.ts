// On-device article chat: one intent per turn, run through the cloud agent's
// own executors (already-following guard, choose-one refusal and all). The
// context reads are copies of the cloud agent's private ones, so the cloud
// class stays untouched.

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
import { getSuggestionFeedbackContext } from '../../../database/services/article-suggestion-reads';
import { ArticleSuggestionStatus } from '../../../database/article-suggestion-status';
import { ArticleService } from '../../../article-service';
import type { TrackFeedbackSubject } from '../../../news-harness/core/types';
import { useFloatingChatStore } from '../../../stores/floating-chat-store';
import { isSubjectTracked } from '../../../tracking/track-actions';
import { ArticleFeedbackAgent } from '../ArticleFeedbackAgent';
import type { ConversationMessage } from '../../types';
import type { OnDeviceAgent } from './types';
import { appLanguageName, chatTurns, respondStructured, today } from './run';

function day(raw: string | null | undefined): string | null {
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? today(ms) : null;
}

export class ArticleFeedbackOnDeviceAgent implements OnDeviceAgent {
  readonly onDevice = true;
  readonly id: string;
  private readonly cloud: ArticleFeedbackAgent;
  private relatedCoverage: Promise<string[]> | null = null;

  constructor(
    userId: string,
    private readonly target: { articleId?: string; suggestionId?: string },
    private readonly trackSubject?: TrackFeedbackSubject | null,
  ) {
    this.cloud = new ArticleFeedbackAgent(userId, target, trackSubject);
    this.id = this.cloud.id;
  }

  /** Sibling titles from the story cluster, only when the chat opened from a Track tap. Failure is []. */
  private getRelatedCoverage(): Promise<string[]> {
    if (this.relatedCoverage) return this.relatedCoverage;
    const articleId = this.trackSubject?.articleId;
    const ownTitle = this.trackSubject?.title;
    this.relatedCoverage = !articleId
      ? Promise.resolve([])
      : ArticleService.getNewsClusterForArticle(articleId)
          .then((cluster) => {
            const titles: string[] = [];
            for (const a of cluster?.articles?.articles ?? []) {
              const title = a?.title_en_internal_only ?? a?.title ?? null;
              if (typeof title !== 'string') continue;
              const trimmed = title.trim();
              if (!trimmed || trimmed === ownTitle) continue;
              titles.push(trimmed);
              if (titles.length >= 5) break;
            }
            return titles;
          })
          .catch(() => []);
    return this.relatedCoverage;
  }

  /** The explicit track subject, else a minimal one from the target and the chat's title. */
  private resolveTrackSubject(): TrackFeedbackSubject | null {
    if (this.trackSubject) return this.trackSubject;
    const articleId = this.target.articleId;
    if (!articleId) return null;
    const storeContext = useFloatingChatStore.getState().context;
    const title = storeContext.kind === 'article-suggestion' ? storeContext.articleTitle : undefined;
    return { origin: 'suggestion', surface: 'detail', articleId, title: title ?? '' };
  }

  private async context(): Promise<ArticleChatContext> {
    const [ctx, relatedCoverage] = await Promise.all([
      getSuggestionFeedbackContext(this.target),
      this.getRelatedCoverage(),
    ]);
    const store = useFloatingChatStore.getState();
    const chat = store.context.kind === 'article-suggestion' ? store.context : null;
    const subject = this.resolveTrackSubject();
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
      relevance: s && s.status === ArticleSuggestionStatus.Complete ? s.relevance : null,
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
