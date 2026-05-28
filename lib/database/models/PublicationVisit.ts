import { Model } from '@nozbe/watermelondb';
import { field, date } from '@nozbe/watermelondb/decorators';

export default class PublicationVisit extends Model {
  static table = 'publication_visits';

  @field('publication_name') publicationName!: string;
  @field('country_code') countryCode!: string | null;
  @field('article_id') articleId!: string | null;
  @field('article_suggestion_id') articleSuggestionId!: string | null;
  @field('article_url') articleUrl!: string | null;
  @field('title_en') titleEn!: string | null;
  @field('title_original') titleOriginal!: string | null;
  @field('language_code') languageCode!: string | null;
  @field('image_url') imageUrl!: string | null;
  @date('pub_date') pubDate!: Date | null;
  @date('visited_at') visitedAt!: Date;
}
