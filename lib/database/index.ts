import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import logger from '../logger';

import migrations from './migrations';
import schema from './schema';

import ArticleSuggestion from './models/ArticleSuggestion';
import ArticleSuggestionFact from './models/ArticleSuggestionFact';
import Conversation from './models/Conversation';
import Fact from './models/Fact';
import Message from './models/Message';
import InferenceJob from './models/InferenceJob';
import SchedulerJob from './models/SchedulerJob';
import Setting from './models/Setting';
import UserPersona from './models/UserPersona';
import PublicationVisit from './models/PublicationVisit';
import SavedArticleSuggestion from './models/SavedArticleSuggestion';
import ArticleFeedback from './models/ArticleFeedback';
import Topic from './models/Topic';
import Location from './models/Location';
import PublicationPreference from './models/PublicationPreference';
import PersonaSuppression from './models/PersonaSuppression';
import PersonaChangeLog from './models/PersonaChangeLog';
import StoryImpression from './models/StoryImpression';
import Notification from './models/Notification';
import PersonaSummaryString from './models/PersonaSummaryString';
import TrackedStory from './models/TrackedStory';

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
    ArticleSuggestion,
    ArticleSuggestionFact,
    Conversation,
    Message,
    UserPersona,
    PublicationVisit,
    SavedArticleSuggestion,
    ArticleFeedback,
    Setting,
    InferenceJob,
    SchedulerJob,
    Topic,
    Location,
    PublicationPreference,
    PersonaSuppression,
    PersonaChangeLog,
    StoryImpression,
    Notification,
    PersonaSummaryString,
    TrackedStory,
  ],
});

export default database;
