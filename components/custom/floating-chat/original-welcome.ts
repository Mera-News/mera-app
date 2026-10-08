import type { ChatContext } from '@/lib/stores/floating-chat-store';

/**
 * The original welcome (`personaChat.introMessage`) and its four send-on-tap
 * chips open the chat from You > Profile, and from the Feed while the reader
 * has no facts. Every other entry keeps the page opener (`meraIntro.*`) and
 * its draft starters. `hasFacts` is null until the first facts read.
 */
export function usesOriginalWelcome(context: ChatContext, hasFacts: boolean | null): boolean {
  if (context.kind !== 'persona') return false;
  if (context.page === 'profile') return true;
  return context.page === 'feed' && hasFacts === false;
}

/** Feed opened before the facts read answered: show neither opener yet. */
export function awaitsFactsRead(context: ChatContext, hasFacts: boolean | null): boolean {
  return context.kind === 'persona' && context.page === 'feed' && hasFacts === null;
}
