import type { ChatContext } from '@/lib/stores/floating-chat-store';

/**
 * Mera opened from You > Profile greets with the original welcome
 * (`personaChat.introMessage`) and its four send-on-tap chips. Every other
 * entry keeps the page opener (`meraIntro.*`) and its draft starters.
 */
export function usesProfileWelcome(context: ChatContext): boolean {
  return context.kind === 'persona' && context.page === 'profile';
}
