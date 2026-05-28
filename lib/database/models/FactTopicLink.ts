import { Model } from '@nozbe/watermelondb';
import { field, immutableRelation } from '@nozbe/watermelondb/decorators';
import type { Relation } from '@nozbe/watermelondb';
import type Fact from './Fact';

export default class FactTopicLink extends Model {
  static table = 'fact_topic_links';

  static associations = {
    facts: { type: 'belongs_to' as const, key: 'fact_id' },
  } as const;

  @field('fact_id') factId!: string;
  @field('server_topic_id') serverTopicId!: string;
  @field('topic_text') topicText!: string;

  @immutableRelation('facts', 'fact_id') fact!: Relation<Fact>;
}
