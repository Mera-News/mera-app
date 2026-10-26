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
import TranslationCache from './models/TranslationCache';
import FactCheckRecord from './models/FactCheckRecord';
import UserPublicationSubscription from './models/UserPublicationSubscription';
import DeclinedTopic from './models/DeclinedTopic';

const LOCKED_RETRIES = 3;
const LOCKED_WAIT_MS = 200;

/**
 * With JSI the SQLiteAdapter constructor opens SQLite synchronously, and the
 * native open runs `journal_mode = WAL` BEFORE `busy_timeout`, so a lock the
 * previous JS runtime still holds (an OTA reload) throws at once instead of
 * waiting. Retry a "database is locked" a few times; rethrow anything else.
 * shortcut: a JS retry around the native open; the real fix is a native patch
 * setting busy_timeout before WAL, at the next native build.
 */
export function createAdapterWithRetry<T>(factory: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return factory();
    } catch (error) {
      const locked = /database is locked/i.test(error instanceof Error ? error.message : String(error));
      if (!locked || attempt >= LOCKED_RETRIES) throw error;
      logger.warn('[database] locked at open, retrying', { attempt: attempt + 1 });
      // A busy-wait, because this runs at module load: every importer needs
      // the database synchronously, so there is nothing to await.
      const until = Date.now() + LOCKED_WAIT_MS;
      while (Date.now() < until) {
        // spin
      }
    }
  }
}

const adapter = createAdapterWithRetry(
  () =>
    new SQLiteAdapter({
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
    }),
);

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
    TranslationCache,
    FactCheckRecord,
    UserPublicationSubscription,
    DeclinedTopic,
  ],
});

export default database;
