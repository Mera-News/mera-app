import { Model } from '@nozbe/watermelondb';
import { field, text, date } from '@nozbe/watermelondb/decorators';

/**
 * One machine translation of a piece of server English text into one target
 * language, produced by the OS translator.
 *
 * DERIVED state — safe to sweep, safe to lose. The row `id` is
 * `${sourceHash}:${targetLang}` (see `translation-cache-service`), so lookups
 * are primary-key hits. `sourceText` is kept in full and compared on read, so a
 * hash collision degrades to a cache miss rather than a wrong translation.
 */
export default class TranslationCache extends Model {
  static table = 'translation_cache';

  @field('source_hash') sourceHash!: string;
  @field('target_lang') targetLang!: string;
  @text('source_text') sourceText!: string;
  @text('translated_text') translatedText!: string;
  @date('created_at') createdAt!: Date;
  @date('last_used_at') lastUsedAt!: Date;
}
