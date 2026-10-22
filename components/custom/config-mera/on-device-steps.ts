// The On this phone tab's three steps, from what is on the phone. Pure, so it
// carries a unit test; the screen hands each status to StepsAccordion.
//   1 model: the Mera relevance model, downloaded once
//   2 on:    Mera runs on this phone (opens once the model is on disk)
//   3 chat:  where Mera chat runs (opens once On this phone is on)

import type { StepStatus } from '@/components/ui/steps-accordion';

/** Step 1's state. `cantRun` wins over everything: this phone never runs it. */
export type ModelPhase = 'cantRun' | 'missing' | 'downloading' | 'failed' | 'ready';

export interface OnDeviceStepsInput {
  onDisk: boolean;
  download: 'queued' | 'downloading' | 'failed' | null;
  /** Null while the requirement check runs. */
  deviceSupported: boolean | null;
  /** The mode actually running is On this phone. */
  onDevice: boolean;
  chatInCloud: boolean;
}

export interface OnDeviceSteps {
  model: StepStatus;
  on: StepStatus;
  chat: StepStatus;
  phase: ModelPhase;
  /** Step 3 is open with cloud chat on: its web search and Verify rows show. */
  cloudChat: boolean;
}

export function onDeviceSteps(i: OnDeviceStepsInput): OnDeviceSteps {
  const phase: ModelPhase =
    i.deviceSupported === false
      ? 'cantRun'
      : i.onDisk
        ? 'ready'
        : i.download === 'failed'
          ? 'failed'
          : i.download
            ? 'downloading'
            : 'missing';
  const ready = phase === 'ready';
  const on: StepStatus = !ready ? 'hidden' : i.onDevice ? 'done' : 'open';
  const chat: StepStatus = on === 'done' ? 'open' : 'hidden';
  return { model: ready ? 'done' : 'open', on, chat, phase, cloudChat: chat === 'open' && i.chatInCloud };
}
