import { Model } from '@nozbe/watermelondb';
import { field, date, immutableRelation } from '@nozbe/watermelondb/decorators';
import type { Relation } from '@nozbe/watermelondb';
import type Fact from './Fact';

export default class NoisyUserTopic extends Model {
  static table = 'noisy_user_topics';

  static associations = {
    facts: { type: 'belongs_to' as const, key: 'fact_id' },
  } as const;

  @field('server_id') serverId!: string;
  @field('user_persona_id') userPersonaId!: string;
  @field('fact_id') factId!: string | null;
  @field('news_topic_text') newsTopicText!: string;
  @field('parent_topic_text') parentTopicText!: string | null;
  @date('created_at') createdAt!: Date;

  @immutableRelation('facts', 'fact_id') fact!: Relation<Fact>;
}
