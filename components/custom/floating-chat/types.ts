import { createContext } from 'react';

export * from '@/lib/chat-session/cards/types';

/** True inside the wizard's chat step. A context so CloudPersonaChat, between the
 *  step and the view, carries none of this. */
export const OnboardingChatContext = createContext(false);
