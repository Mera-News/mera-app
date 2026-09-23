// lib/mera-harness — the public surface.
//
// Everything outside this folder imports from HERE, never from a file inside
// it. The RN driver (useCloudPersonaChat), the DB-backed tool port, the UI and
// place-service are all consumers; nothing in here imports any of them.
// __tests__/boundary.test.ts enforces that for the whole folder.

export type {
  AgentChoiceOption,
  AgentDeps,
  AgentLeg,
  AgentModelRequest,
  AgentModelResult,
  AgentProposal,
  AgentToolPort,
  AgentTurnResult,
  AgentTurnState,
  AskChoiceResult,
  Bloc,
  FindSimilarFactsArgs,
  FindSimilarFactsResult,
  LoadSkillResult,
  LookupPlaceArgs,
  LookupPlaceResult,
  Place,
  PlaceChain,
  SimilarFactCandidate,
} from './core/types';
export { createAgentTurnState } from './core/types';

// Dash cleanup for model prose that does NOT go through the loop (the
// single-shot agents). Same rule the loop applies to its own replies.
export { replaceClauseDashes } from './core/prose';

// The replacement card decides whether "Keep both" makes sense from the two
// facts' attribute keys, with the same helpers the loop uses to gate a replace.
export { attributeKey, isLocationKey, isRelationalStatement, mayReplaceKey, sameAttributeKey } from './core/fact-subject';
export { isCombinedOriginFact } from './core/combined-fact';

export {
  MAX_AGENT_LEGS,
  MAX_FACTS_IN_CONTEXT,
  createAgentState,
  estimateTokens,
  formatKnownFacts,
  runAgentTurn,
  type AgentPersona,
  type AgentPersonaFact,
  type AgentState,
  type RunAgentTurnParams,
} from './core/core';

export {
  MAX_TOPICS_PER_FACT,
  TOPIC_CALL_MAX_TOKENS,
  TOPIC_CALL_TEMPERATURE,
  buildTopicUserMessage,
  generateTopicsForFact,
  normalizeTopicText,
  parseTopics,
  type GenerateTopicsOutcome,
  type GenerateTopicsParams,
  type TopicCallFact,
} from './core/topic-call';

export {
  ASK_CHOICE_TOOL,
  CONTINUATION_TOOLS,
  FIND_SIMILAR_FACTS_TOOL,
  HARNESS_TOOLS,
  LOAD_SKILL_TOOL,
  LOOKUP_PLACE_TOOL,
  MAX_CHOICE_OPTIONS,
  MIN_CHOICE_OPTIONS,
  validateChoiceOptions,
  type ToolDefinition,
} from './core/tool-contracts';

export {
  BASELINE_ARM,
  agentArmIds,
  dedupeModeFor,
  personaPromptFor,
  registerAgentArm,
  resetAgentArmsForTest,
  resolveAgentArm,
  topicPromptFor,
  type AgentArm,
} from './core/arms';

export {
  buildRouterPrompt,
  type PersonaSurface,
  type RouterPromptInput,
} from './core/router-prompt';

export {
  hasSkill,
  loadSkill,
  renderSkillIndex,
  skillIds,
  skillIndexRows,
  type SkillId,
  type SkillIndexRow,
} from './core/skill-loader';

export {
  DETECT_JACCARD,
  FILTER_DROP_JACCARD,
  contentJaccard,
  isSubsetTopic,
  sharedTokens,
} from './core/topic-similarity';

export {
  filterNearDuplicates,
  type DedupeDrop,
  type DedupeResult,
} from './core/topic-dedupe';

export { buildStateLine, escapeUntrusted, type StateLineInput } from './core/state-line';
