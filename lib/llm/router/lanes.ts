/**
 * The routing lanes (route1 contract). Every model call names one; the router ranks profiles per lane.
 * Kept dependency-free so stores and components can import it without pulling the router.
 */
export type Lane = 'chat-tools' | 'chat-single' | 'fact-check' | 'scoring' | 'topics' | 'background';

export const LANES: readonly Lane[] = ['chat-tools', 'chat-single', 'fact-check', 'scoring', 'topics', 'background'];

/** The lanes chat-in-cloud lets through while On this phone. */
export const CHAT_LANES: readonly Lane[] = ['chat-tools', 'chat-single', 'fact-check'];
