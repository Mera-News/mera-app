// Module memory the integration setup does not reset (it resets storage, the DB, auth, the mock
// scenario and the gateway state). Chat tests call resetChatModules() in beforeEach.
import { __resetAppRestartForTests } from '@/lib/app-restart';
import { invalidateJwtCache } from '@/lib/auth-client';
import { resetChatSession } from '@/lib/chat-session/chat-session';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';

/** Resets every piece of chat module state a test can leave behind. Does not sign in. */
export function resetChatModules(): void {
  resetLimiter();
  resetModelFallback();
  __resetOnDeviceGateForTests();
  clearAttestationCache();
  invalidateJwtCache();
  stopAskedFactCheckPollerForTest();
  // Disposes the live engine, empties the cloud and on-device chat stores, drops the restart hold.
  resetChatSession();
  // Restart holds (the chat session's 'chat-stream', model loads, local inference).
  __resetAppRestartForTests();
  useChatPhaseStore.getState().reset();
  useFloatingChatStore.getState().reset();
  useCloudChatStore.getState().reset();
}
