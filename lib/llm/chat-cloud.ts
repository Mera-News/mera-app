// Where CHAT runs. Private cloud runs everything in the cloud; On this phone runs
// chat on the phone unless the reader turned on cloud chat (`chatInCloud`), and
// even then the feed, topic gen and every background job stay on the phone
// (they read `processingMode`, never this). The gate's async twin of this rule is
// `assertCloudAllowed('chat')` in on-device-gate.ts.

import { ProcessingMode } from '../generated/graphql-types';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';

type ChatModeState = { processingMode: ProcessingMode; chatInCloud: boolean };

const runsInCloud = (s: ChatModeState): boolean =>
  s.processingMode !== ProcessingMode.OnDevice || s.chatInCloud === true;

/** True when a chat turn uses the cloud engine, model and tools. */
export function chatRunsInCloud(): boolean {
  return runsInCloud(useMeraProtocolStore.getState());
}

/** Reactive `chatRunsInCloud()` for components. */
export const useChatRunsInCloud = (): boolean => useMeraProtocolStore(runsInCloud);
