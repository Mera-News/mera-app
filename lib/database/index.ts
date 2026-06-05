import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import logger from '../logger';

import migrations from './migrations';
import schema from './schema';

import ArticleSuggestion from './models/ArticleSuggestion';
import ArticleSuggestionFact from './models/ArticleSuggestionFact';
import Fact from './models/Fact';
import FactTopicLink from './models/FactTopicLink';
import InferenceJob from './models/InferenceJob';
import Setting from './models/Setting';
import UserPersona from './models/UserPersona';
import UserTopic from './models/UserTopic';
import NoisyUserTopic from './models/NoisyUserTopic';
import PublicationVisit from './models/PublicationVisit';

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  jsi: true,
  onSetUpError: (error) => {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.error('[WMDB setup error]', error, (error as any)?.message, (error as any)?.stack);
    }
    logger.captureException(error, { tags: { source: 'watermelondb', method: 'onSetUpError' } });
  },
});

const database = new Database({
  adapter,
  modelClasses: [
    Fact,
    FactTopicLink,
    ArticleSuggestion,
    ArticleSuggestionFact,
    UserPersona,
    UserTopic,
    NoisyUserTopic,
    PublicationVisit,
    Setting,
    InferenceJob,
  ],
});

export default database;
