import { Model } from '@nozbe/watermelondb';
import { field, date, immutableRelation } from '@nozbe/watermelondb/decorators';
import type { Relation } from '@nozbe/watermelondb';
import type UserPersonaModel from './UserPersona';

export default class UserTopic extends Model {
  static table = 'user_topics';

  static associations = {
    user_personas: { type: 'belongs_to' as const, key: 'user_persona_id' },
  } as const;

  @field('server_id') serverId!: string;
  @field('user_persona_id') userPersonaId!: string;
  @field('news_topic_text') newsTopicText!: string;
  @field('article_count') articleCount!: number;
  @field('cluster_count') clusterCount!: number;
  @field('is_canonical') isCanonical!: boolean;
  @date('created_at') createdAt!: Date;
  @date('updated_at') updatedAt!: Date;

  @immutableRelation('user_personas', 'user_persona_id')
  userPersona!: Relation<UserPersonaModel>;
}
