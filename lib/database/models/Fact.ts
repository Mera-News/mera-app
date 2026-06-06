import { Model } from '@nozbe/watermelondb';
import { text, json, date, field, children, writer } from '@nozbe/watermelondb/decorators';
import type { Query } from '@nozbe/watermelondb';
import type FactTopicLink from './FactTopicLink';

const sanitizeMetadata = (raw: unknown) => raw || undefined;

export default class Fact extends Model {
  static table = 'facts';

  static associations = {
    fact_topic_links: { type: 'has_many' as const, foreignKey: 'fact_id' },
  } as const;

  @text('statement') statement!: string;
  @json('metadata_json', sanitizeMetadata) metadata?: Record<string, string[]>;
  @field('questionnaire_level') questionnaireLevel?: number;
  @text('questionnaire_level_category') questionnaireLevelCategory?: string;
  @text('questionnaire_attribute') questionnaireAttribute?: string;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  @children('fact_topic_links') topicLinks!: Query<FactTopicLink>;

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
    const links = await this.topicLinks.fetch();
    const batch: Model[] = [
      ...links.map((link) => link.prepareDestroyPermanently()),
      this.prepareDestroyPermanently(),
    ];
    await this.batch(...batch);
  }
}
