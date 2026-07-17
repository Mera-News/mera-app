// news-harness — public surface.
//
// The shared "AI-flow system": pure logic for article relevance scoring, topic
// generation, fact-acceptance rules, and the prompt/questionnaire data they use.
// Nothing here imports lib/logger, lib/config/endpoints, lib/database/*,
// lib/stores/*, or any expo/react-native/watermelondb/zustand module — RN
// coupling is injected through the ports in ./core/ports.

export * from './core/types';
export * from './core/ports';
export * from './core/config';
export * from './prompts/prompts';
export * from './prompts/questionnaire-data';
export * from './persona-management/fact-rules';
export * from './persona-management/topic-generation';
export * from './persona-management/persona-agent-core';
export * from './article-pipeline/scoring';
export * from './article-pipeline/candidates';
export * from './article-pipeline/pipeline';
export * from './article-feedback/agent-core';
export * from './scoring-engine';
