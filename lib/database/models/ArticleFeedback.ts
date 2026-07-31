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
  // Feed-verdict processing marker (schema v42). Epoch ms; null means "still
  // pending for the 3-hourly digest". Since D15 it reads as "not pending"
  // rather than "folded in": a BARE verdict (no context_json.treePath) is
  // stamped at write so it is discarded, and a terminal tree leaf stamps it
  // again right after applying its persona actions on the spot. Only the
  // in-between state — a verdict carrying a part-way tree path — is null.
  @field('processed_at') processedAt!: number | null;
  @date('created_at') createdAt!: Date;
}
