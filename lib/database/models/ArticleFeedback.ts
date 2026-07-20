import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

export default class ArticleFeedback extends Model {
  static table = 'article_feedback';

  @field('article_id') articleId!: string;
  @field('suggestion_id') suggestionId!: string | null;
  @field('sentiment') sentiment!: string;
  @field('title') title!: string;
  // Origin-aware feedback (schema v38). `origin` = 'suggestion' | 'article',
  // `surface` = the on-screen surface the tap came from, `contextJson` = a JSON
  // snapshot of the FeedbackSubject extras. All nullable — legacy rows written
  // by ArticleFeedbackPrompt leave them null.
  @field('origin') origin!: string | null;
  @field('surface') surface!: string | null;
  @field('context_json') contextJson!: string | null;
  @date('created_at') createdAt!: Date;
}
