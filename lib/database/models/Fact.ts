import { Model, Q } from '@nozbe/watermelondb';
import { text, json, date, field, writer } from '@nozbe/watermelondb/decorators';

const sanitizeMetadata = (raw: unknown) => raw || undefined;

/**
 * Where the most recent topic-generation run for a fact got to.
 *
 * Declared HERE rather than in the toolkit's `types.ts`, whose `Fact` DTO
 * carries the same union inline: the toolkit type must stay self-contained and
 * must never import from `lib/database`. TypeScript is structural, so the two
 * assign freely in both directions.
 *
 * NULL (absent) is a real, common state meaning generation was never asked for.
 * Render it exactly like 'done' — never a spinner, never an error.
 */
export type FactTopicsStatus = 'pending' | 'done' | 'error';

export default class Fact extends Model {
  static table = 'facts';

  @text('statement') statement!: string;
  @json('metadata_json', sanitizeMetadata) metadata?: Record<string, string[]>;
  @field('questionnaire_level') questionnaireLevel?: number;
  @text('questionnaire_level_category') questionnaireLevelCategory?: string;
  @text('questionnaire_attribute') questionnaireAttribute?: string;
  // Persona v3 fact-level weight multiplier. null ⇒ treated as 1.0.
  @field('weight') weight?: number | null;
  // Topic generation progress (v55). NOT authoritative over the `topics` table:
  // it reports the RUN, the table owns what exists. Never gates rendering.
  @field('topics_status') topicsStatus!: FactTopicsStatus | null;
  @date('topics_updated_at') topicsUpdatedAt!: Date | null;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  @writer async updateFact(
    statement: string,
    metadata?: Record<string, string[]>,
    questionnaire?: {
      level?: number;
      levelCategory?: string;
      attribute?: string;
    },
  ) {
    await this.update((fact) => {
      fact.statement = statement;
      if (metadata !== undefined) {
        fact.metadata = metadata;
      }
      if (questionnaire) {
        if (questionnaire.level !== undefined) fact.questionnaireLevel = questionnaire.level;
        if (questionnaire.levelCategory !== undefined) fact.questionnaireLevelCategory = questionnaire.levelCategory;
        if (questionnaire.attribute !== undefined) fact.questionnaireAttribute = questionnaire.attribute;
      }
    });
  }

  /**
   * Stamp the topic-generation status, touching ONLY those two columns.
   *
   * Deliberately not routed through `updateFact`, which assigns
   * `fact.metadata` WHOLESALE and would clobber `topics`, `topicGenError` and
   * `topicsReviewedAt` for a caller that only wanted to move a status.
   */
  @writer async setTopicsStatus(status: FactTopicsStatus, at: Date = new Date()) {
    await this.update((fact) => {
      fact.topicsStatus = status;
      fact.topicsUpdatedAt = at;
      fact.updatedAt = at;
    });
  }

  @writer async destroyCascade() {
    // The cascade must be real: topics carry this fact's id, and an orphaned
    // ACTIVE topic keeps fetching and matching feed content for an interest
    // the user deleted — while the Dashboard drops every suggestion it claims
    // (ownership resolution requires the fact snapshot). Measured 2026-08-03:
    // a device with 74 orphaned topics rendered a permanently empty Dashboard.
    const topics = await this.collections
      .get('topics')
      .query(Q.where('fact_id', this.id))
      .fetch();
    await this.batch(
      this.prepareDestroyPermanently(),
      ...topics.map((t) => t.prepareDestroyPermanently()),
    );
  }
}
