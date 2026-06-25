export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: any; output: any; }
};

export type ArticleIdsForTopicsResponse = {
  __typename?: 'ArticleIdsForTopicsResponse';
  results: Array<TopicArticleIdsResult>;
};

/** Status of article processing through the pipeline */
export enum ArticleProcessingStatus {
  AggregationEnqueued = 'AGGREGATION_ENQUEUED',
  AggregationFailed = 'AGGREGATION_FAILED',
  AggregationSuccessful = 'AGGREGATION_SUCCESSFUL',
  DetectLanguageEnqueued = 'DETECT_LANGUAGE_ENQUEUED',
  DetectLanguageFailed = 'DETECT_LANGUAGE_FAILED',
  DetectLanguageSuccessful = 'DETECT_LANGUAGE_SUCCESSFUL',
  EmbeddingEnqueued = 'EMBEDDING_ENQUEUED',
  EmbeddingFailed = 'EMBEDDING_FAILED',
  EmbeddingSuccessful = 'EMBEDDING_SUCCESSFUL',
  Pending = 'PENDING',
  TranslationEnqueued = 'TRANSLATION_ENQUEUED',
  TranslationFailed = 'TRANSLATION_FAILED',
  TranslationSkipped = 'TRANSLATION_SKIPPED',
  TranslationSuccess = 'TRANSLATION_SUCCESS'
}

/** Sibling article returned by the relatedArticles query */
export type ArticleSummary = {
  __typename?: 'ArticleSummary';
  _id: Scalars['ID']['output'];
  article_url?: Maybe<Scalars['String']['output']>;
  country_code?: Maybe<Scalars['String']['output']>;
  description_en?: Maybe<Scalars['String']['output']>;
  image_url?: Maybe<Scalars['String']['output']>;
  language_code?: Maybe<Scalars['String']['output']>;
  pubDate: Scalars['DateTime']['output'];
  publication_name?: Maybe<Scalars['String']['output']>;
  title_en: Scalars['String']['output'];
};

/** Article summary with cluster membership — used by Flow v2 hydration */
export type ArticleWithClusters = {
  __typename?: 'ArticleWithClusters';
  _id: Scalars['ID']['output'];
  article_url?: Maybe<Scalars['String']['output']>;
  clusters: Array<ClusterMembership>;
  country_code?: Maybe<Scalars['String']['output']>;
  description_en?: Maybe<Scalars['String']['output']>;
  image_url?: Maybe<Scalars['String']['output']>;
  language_code?: Maybe<Scalars['String']['output']>;
  pubDate: Scalars['DateTime']['output'];
  publication_name?: Maybe<Scalars['String']['output']>;
  title?: Maybe<Scalars['String']['output']>;
  title_en: Scalars['String']['output'];
};

export type ArticlesForPublicationSourceResponse = {
  __typename?: 'ArticlesForPublicationSourceResponse';
  articles: Array<NewsArticle>;
  pageInfo: CursorPageInfo;
};

/** Hydrated articles for a set of IDs, plus the daily-delivery-cap signal. The cap is charged here (delivery point), so a clipped response means the user hit their daily article limit — distinct from IDs that simply TTL'd out. */
export type ArticlesForTopicsByIdsResponse = {
  __typename?: 'ArticlesForTopicsByIdsResponse';
  articles: Array<ArticleWithClusters>;
  /** True when the user's daily article-delivery cap clipped this response (fewer articles returned than requested). */
  dailyLimitReached: Scalars['Boolean']['output'];
  /** ISO timestamp of the next 00:00 UTC when the daily cap resets; set only when dailyLimitReached is true. */
  resetAt?: Maybe<Scalars['String']['output']>;
};

export type ClusterArticlesConnection = {
  __typename?: 'ClusterArticlesConnection';
  articles: Array<NewsArticle>;
  pageInfo: CursorPageInfo;
};

/** Membership of an article in a cluster, with the HDBSCAN confidence (0.0–1.0) */
export type ClusterMembership = {
  __typename?: 'ClusterMembership';
  clusterId: Scalars['ID']['output'];
  confidence: Scalars['Float']['output'];
};

export type CursorPageInfo = {
  __typename?: 'CursorPageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  pageSize: Scalars['Int']['output'];
};

export type DeleteAllUserTopicsResponse = {
  __typename?: 'DeleteAllUserTopicsResponse';
  removedCount: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
};

export type DeleteExpoPushTokenInput = {
  userId: Scalars['ID']['input'];
};

export type EmbeddingSearchResponse = {
  __typename?: 'EmbeddingSearchResponse';
  query: Scalars['String']['output'];
  results: Array<EmbeddingSearchResult>;
  totalResults: Scalars['Float']['output'];
};

export type EmbeddingSearchResult = {
  __typename?: 'EmbeddingSearchResult';
  article: NewsArticle;
  score: Scalars['Float']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  advanceOnboardingStage: UserPersona;
  deleteAllUserTopics: DeleteAllUserTopicsResponse;
  deleteExpoPushToken: UserPersona;
  submitUserTopics: SubmitUserTopicsResponse;
  updateExpoPushToken: UserPersona;
  updateNotificationWindow: UserPersona;
  updateNotificationsEnabled: UserPersona;
  updateProcessingMode: UserPersona;
  updateUserConfig: UserPersona;
  withdrawUserTopics: WithdrawUserTopicsResponse;
};


export type MutationAdvanceOnboardingStageArgs = {
  stage: OnboardingStage;
  userId: Scalars['ID']['input'];
};


export type MutationDeleteAllUserTopicsArgs = {
  userId: Scalars['ID']['input'];
};


export type MutationDeleteExpoPushTokenArgs = {
  input: DeleteExpoPushTokenInput;
};


export type MutationSubmitUserTopicsArgs = {
  input: SubmitUserTopicsInput;
};


export type MutationUpdateExpoPushTokenArgs = {
  input: UpdateExpoPushTokenInput;
};


export type MutationUpdateNotificationWindowArgs = {
  input: UpdateNotificationWindowInput;
};


export type MutationUpdateNotificationsEnabledArgs = {
  input: UpdateNotificationsEnabledInput;
};


export type MutationUpdateProcessingModeArgs = {
  input: UpdateProcessingModeInput;
};


export type MutationUpdateUserConfigArgs = {
  input: UpdateUserConfigInput;
};


export type MutationWithdrawUserTopicsArgs = {
  input: WithdrawUserTopicsInput;
};

export type NewsArticle = {
  __typename?: 'NewsArticle';
  _id: Scalars['ID']['output'];
  article_url: Scalars['String']['output'];
  clusterConfidence?: Maybe<Scalars['Float']['output']>;
  createdAt: Scalars['DateTime']['output'];
  creator?: Maybe<Scalars['String']['output']>;
  description: Scalars['String']['output'];
  description_en_internal_only?: Maybe<Scalars['String']['output']>;
  fetchPublicationId?: Maybe<Scalars['ID']['output']>;
  image_url?: Maybe<Scalars['String']['output']>;
  original_language_code?: Maybe<Scalars['String']['output']>;
  processingStatus?: Maybe<ArticleProcessingStatus>;
  pubDate: Scalars['DateTime']['output'];
  publicationSource?: Maybe<PublicationSource>;
  publicationSourceId: Scalars['ID']['output'];
  source_uri: Scalars['String']['output'];
  title: Scalars['String']['output'];
  title_en_internal_only?: Maybe<Scalars['String']['output']>;
  type: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type NewsCluster = {
  __typename?: 'NewsCluster';
  _id: Scalars['ID']['output'];
  articles: ClusterArticlesConnection;
  clusterSize?: Maybe<Scalars['Int']['output']>;
  createdAt: Scalars['DateTime']['output'];
  topicConfidence?: Maybe<Scalars['Float']['output']>;
  updatedAt: Scalars['DateTime']['output'];
};


export type NewsClusterArticlesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type NewsClustersResponse = {
  __typename?: 'NewsClustersResponse';
  newsClusters: Array<NewsCluster>;
  pageInfo: CursorPageInfo;
};

export type NewsPublisher = {
  __typename?: 'NewsPublisher';
  _id: Scalars['ID']['output'];
  country_code: Scalars['String']['output'];
  country_name?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  is_active: Scalars['Boolean']['output'];
  name: Scalars['String']['output'];
  publicationSources: Array<PublicationSource>;
  updatedAt: Scalars['DateTime']['output'];
  website_url?: Maybe<Scalars['String']['output']>;
};

export type NewsPublishersResponse = {
  __typename?: 'NewsPublishersResponse';
  newsPublishers: Array<NewsPublisher>;
  pageInfo: CursorPageInfo;
};

/** Monotonic onboarding progress marker. Values: NOTIFICATIONS, PROCESSING_MODE, PERSONA_CHAT, FINISHED. The user resumes at this stage on app launch; only FINISHED skips the wizard. */
export enum OnboardingStage {
  Finished = 'FINISHED',
  Notifications = 'NOTIFICATIONS',
  PersonaChat = 'PERSONA_CHAT',
  ProcessingMode = 'PROCESSING_MODE'
}

/** Which inference backend handles Mera Protocol work for this user. ON_DEVICE runs fully offline on the user device; CLOUD uses end-to-end encrypted inference. */
export enum ProcessingMode {
  Cloud = 'CLOUD',
  OnDevice = 'ON_DEVICE'
}

export type PublicationSource = {
  __typename?: 'PublicationSource';
  _id: Scalars['ID']['output'];
  category: Scalars['String']['output'];
  country_code: Scalars['String']['output'];
  country_name?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  detected_language_code?: Maybe<Scalars['String']['output']>;
  feed_language_code?: Maybe<Scalars['String']['output']>;
  feed_url: Scalars['String']['output'];
  is_active: Scalars['Boolean']['output'];
  newsPublisherId?: Maybe<Scalars['ID']['output']>;
  publication_name: Scalars['String']['output'];
  publication_url?: Maybe<Scalars['String']['output']>;
  type: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

export type PublicationSourcesForPublisherResponse = {
  __typename?: 'PublicationSourcesForPublisherResponse';
  publicationSources: Array<PublicationSource>;
};

export type PublicationSourcesResponse = {
  __typename?: 'PublicationSourcesResponse';
  pageInfo: CursorPageInfo;
  publicationSources: Array<PublicationSource>;
};

export type Query = {
  __typename?: 'Query';
  allCountries: Array<Scalars['String']['output']>;
  /** Fetch a single article by ID. Returns null if not found (e.g. TTL’d out). */
  articleById?: Maybe<NewsArticle>;
  articleIdsForTopics: ArticleIdsForTopicsResponse;
  /** A country's last-24h articles across all its sources, sorted by largest cluster size (top headlines). A null or "GLOBAL" countryCode spans all countries. */
  articlesForCountry: ArticlesForPublicationSourceResponse;
  articlesForPublicationSource: ArticlesForPublicationSourceResponse;
  /** A publisher's last-24h articles aggregated across all its feeds, sorted by largest cluster size (top headlines). */
  articlesForPublisher: ArticlesForPublicationSourceResponse;
  articlesForTopicsByIds: ArticlesForTopicsByIdsResponse;
  newsClusterForUser: NewsCluster;
  newsClusters: NewsClustersResponse;
  newsClustersForTopicText: NewsClustersResponse;
  newsPublishers: NewsPublishersResponse;
  /** @deprecated Use newsPublishers and publicationSourcesForNewsPublisher queries instead */
  publicationSources: PublicationSourcesResponse;
  publicationSourcesForNewsPublisher: PublicationSourcesForPublisherResponse;
  recentArticleCount: Scalars['Int']['output'];
  relatedArticles: Array<ArticleSummary>;
  /** Vector search using cosine similarity (scores 0–1). */
  searchArticlesVector: EmbeddingSearchResponse;
  /** Vector search on user topics using cosine similarity (scores 0–1). */
  searchTopicsVector: TopicSearchResponse;
  userPersonaByUserId?: Maybe<UserPersona>;
};


export type QueryArticleByIdArgs = {
  id: Scalars['ID']['input'];
};


export type QueryArticleIdsForTopicsArgs = {
  limitPerTopic?: Scalars['Int']['input'];
  topics: Array<TopicPaginationInput>;
};


export type QueryArticlesForCountryArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  countryCode?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryArticlesForPublicationSourceArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  publicationSourceId: Scalars['ID']['input'];
};


export type QueryArticlesForPublisherArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  newsPublisherId: Scalars['ID']['input'];
};


export type QueryArticlesForTopicsByIdsArgs = {
  articleIds: Array<Scalars['ID']['input']>;
};


export type QueryNewsClusterForUserArgs = {
  clusterId: Scalars['ID']['input'];
};


export type QueryNewsClustersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  countryCodes?: InputMaybe<Array<Scalars['String']['input']>>;
  first?: InputMaybe<Scalars['Int']['input']>;
  userTopicId?: InputMaybe<Scalars['ID']['input']>;
};


export type QueryNewsClustersForTopicTextArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  topicText: Scalars['String']['input'];
};


export type QueryNewsPublishersArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  countryCode?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
};


export type QueryPublicationSourcesArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  category?: InputMaybe<Scalars['String']['input']>;
  countryCode?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  languageCode?: InputMaybe<Scalars['String']['input']>;
};


export type QueryPublicationSourcesForNewsPublisherArgs = {
  publisherId: Scalars['ID']['input'];
};


export type QueryRelatedArticlesArgs = {
  articleId: Scalars['ID']['input'];
};


export type QuerySearchArticlesVectorArgs = {
  cutoffHours?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  minScore?: InputMaybe<Scalars['Float']['input']>;
  mode?: InputMaybe<VectorSearchMode>;
  numCandidates?: InputMaybe<Scalars['Int']['input']>;
  query: Scalars['String']['input'];
};


export type QuerySearchTopicsVectorArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
  minScore?: InputMaybe<Scalars['Float']['input']>;
  numCandidates?: InputMaybe<Scalars['Int']['input']>;
  query: Scalars['String']['input'];
};


export type QueryUserPersonaByUserIdArgs = {
  userId: Scalars['ID']['input'];
};

export type SubmitUserTopicItemInput = {
  sourceFactLocalId: Scalars['String']['input'];
  text: Scalars['String']['input'];
};

export type SubmitUserTopicsInput = {
  topics: Array<SubmitUserTopicItemInput>;
  userId: Scalars['ID']['input'];
};

export type SubmitUserTopicsResponse = {
  __typename?: 'SubmitUserTopicsResponse';
  message: Scalars['String']['output'];
  success: Scalars['Boolean']['output'];
  topics: Array<SubmittedUserTopic>;
};

export type SubmittedUserTopic = {
  __typename?: 'SubmittedUserTopic';
  sourceFactLocalId: Scalars['String']['output'];
  status: Scalars['String']['output'];
  text: Scalars['String']['output'];
  topicId?: Maybe<Scalars['ID']['output']>;
};

export type TopicArticleIdsResult = {
  __typename?: 'TopicArticleIdsResult';
  articleIds: Array<Scalars['ID']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  nextCursor?: Maybe<Scalars['String']['output']>;
  topicText: Scalars['String']['output'];
};

export type TopicPaginationInput = {
  /** articleId of the last item on the previous page; omit for first page */
  afterCursor?: InputMaybe<Scalars['String']['input']>;
  topicText: Scalars['String']['input'];
};

export type TopicSearchResponse = {
  __typename?: 'TopicSearchResponse';
  query: Scalars['String']['output'];
  results: Array<TopicSearchResult>;
  totalResults: Scalars['Float']['output'];
};

export type TopicSearchResult = {
  __typename?: 'TopicSearchResult';
  score: Scalars['Float']['output'];
  topic: UserTopic;
};

export type UpdateExpoPushTokenInput = {
  expoPushToken: Scalars['String']['input'];
  userId: Scalars['ID']['input'];
};

export type UpdateNotificationWindowInput = {
  preferredNotificationWindow: Array<Scalars['Int']['input']>;
  userId: Scalars['ID']['input'];
};

export type UpdateNotificationsEnabledInput = {
  enabled: Scalars['Boolean']['input'];
  userId: Scalars['ID']['input'];
};

export type UpdateProcessingModeInput = {
  mode: ProcessingMode;
  userId: Scalars['ID']['input'];
};

export type UpdateUserConfigInput = {
  language_codes?: InputMaybe<Array<Scalars['String']['input']>>;
  userId: Scalars['ID']['input'];
};

export type UserPersona = {
  __typename?: 'UserPersona';
  _id: Scalars['ID']['output'];
  blockedByLlm: Scalars['Boolean']['output'];
  blockedByLlmReason?: Maybe<Scalars['String']['output']>;
  createdAt: Scalars['DateTime']['output'];
  expoPushToken?: Maybe<Scalars['String']['output']>;
  language_codes?: Maybe<Array<Scalars['String']['output']>>;
  lastNotifiedAt?: Maybe<Scalars['DateTime']['output']>;
  lastSuccessfulCompletedAt?: Maybe<Scalars['DateTime']['output']>;
  llmWarningCount: Scalars['Int']['output'];
  notificationsEnabled: Scalars['Boolean']['output'];
  onboardingStage: OnboardingStage;
  preferredNotificationWindow: Array<Scalars['Int']['output']>;
  processingMode: ProcessingMode;
  updatedAt: Scalars['DateTime']['output'];
  userId: Scalars['String']['output'];
  userTopics?: Maybe<Array<UserTopic>>;
};

export type UserTopic = {
  __typename?: 'UserTopic';
  _id: Scalars['ID']['output'];
  article_count: Scalars['Int']['output'];
  cluster_count: Scalars['Int']['output'];
  createdAt: Scalars['DateTime']['output'];
  is_canonical: Scalars['Boolean']['output'];
  news_topic_text: Scalars['String']['output'];
  updatedAt: Scalars['DateTime']['output'];
};

/** Which embedding index to use for vector search. DATA_RETRIEVAL uses asymmetric retrieval embeddings (query→article). TEXT_MATCHING uses symmetric text-matching embeddings (article→article clustering). */
export enum VectorSearchMode {
  /** Asymmetric search: query embedding (retrieval.query) vs article embedding (retrieval.passage). Best for user-facing search. */
  DataRetrieval = 'DATA_RETRIEVAL',
  /** Symmetric search: text-matching embeddings. Best for finding similar/duplicate articles (clustering). */
  TextMatching = 'TEXT_MATCHING'
}

export type WithdrawUserTopicsInput = {
  topicIds: Array<Scalars['ID']['input']>;
  userId: Scalars['ID']['input'];
};

export type WithdrawUserTopicsResponse = {
  __typename?: 'WithdrawUserTopicsResponse';
  removedCount: Scalars['Int']['output'];
  success: Scalars['Boolean']['output'];
};
