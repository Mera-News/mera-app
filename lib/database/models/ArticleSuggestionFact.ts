import { Model } from '@nozbe/watermelondb';
import { field, date, immutableRelation } from '@nozbe/watermelondb/decorators';
import type { Relation } from '@nozbe/watermelondb';
import type ArticleSuggestion from './ArticleSuggestion';
import type Fact from './Fact';

export default class ArticleSuggestionFact extends Model {
  static table = 'article_suggestion_facts';

  static associations = {
    article_suggestions: { type: 'belongs_to' as const, key: 'article_suggestion_id' },
    facts: { type: 'belongs_to' as const, key: 'fact_id' },
  } as const;

  @field('article_suggestion_id') articleSuggestionId!: string;
  @field('fact_id') factId!: string;
  @date('created_at') createdAt!: Date;

  @immutableRelation('article_suggestions', 'article_suggestion_id')
  articleSuggestion!: Relation<ArticleSuggestion>;

  @immutableRelation('facts', 'fact_id') fact!: Relation<Fact>;
}
