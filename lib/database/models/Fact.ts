import { Model } from '@nozbe/watermelondb';
import { text, json, date, field, writer } from '@nozbe/watermelondb/decorators';

const sanitizeMetadata = (raw: unknown) => raw || undefined;

export default class Fact extends Model {
  static table = 'facts';

  @text('statement') statement!: string;
  @json('metadata_json', sanitizeMetadata) metadata?: Record<string, string[]>;
  @field('questionnaire_level') questionnaireLevel?: number;
  @text('questionnaire_level_category') questionnaireLevelCategory?: string;
  @text('questionnaire_attribute') questionnaireAttribute?: string;
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
    await this.batch(this.prepareDestroyPermanently());
  }
}
