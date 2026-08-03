import { Model, Q } from '@nozbe/watermelondb';
import { text, json, date, field, writer } from '@nozbe/watermelondb/decorators';

const sanitizeMetadata = (raw: unknown) => raw || undefined;

export default class Fact extends Model {
  static table = 'facts';

  @text('statement') statement!: string;
  @json('metadata_json', sanitizeMetadata) metadata?: Record<string, string[]>;
  @field('questionnaire_level') questionnaireLevel?: number;
  @text('questionnaire_level_category') questionnaireLevelCategory?: string;
  @text('questionnaire_attribute') questionnaireAttribute?: string;
  // Persona v3 fact-level weight multiplier. null ⇒ treated as 1.0.
  @field('weight') weight?: number | null;
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
