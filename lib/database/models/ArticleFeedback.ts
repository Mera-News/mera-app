import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

export default class ArticleFeedback extends Model {
  static table = 'article_feedback';

  @field('article_id') articleId!: string;
  @field('suggestion_id') suggestionId!: string | null;
  @field('sentiment') sentiment!: string;
  @field('title') title!: string;
  @date('created_at') createdAt!: Date;
}
