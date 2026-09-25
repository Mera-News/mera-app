// chat-bug-report — the chat header's bug button (ux2 H).
//
// The chat is end-to-end encrypted, and this is the ONE place it leaves the
// device in readable form: only when the user taps Send on the report form,
// which says so above its fields. Cancel sends nothing. This is support the
// user asked for, not instrumentation (invariant 9).
//
// Sentry's FeedbackWidget has no prop for an attachment beyond its screenshot
// slot, so the transcript rides a ONE-SHOT `beforeSendFeedback` hook: Sentry
// core emits it with the very hint it then captures with, so an attachment
// pushed there goes out with that report and nothing else. The hook is removed
// when the form hides, whether by Send or Cancel, so a later ordinary report
// carries no transcript. Sentry's own scrubbers still apply.

import * as Sentry from '@sentry/react-native';
import { showFeedback } from '@/lib/feedback';
import { stripThinkTags } from '@/lib/llm/think-strip';
import { useFeedbackStore } from '@/lib/stores/feedback-store';
import type { ChatThreadItem } from './types';

export const CHAT_TRANSCRIPT_FILENAME = 'chat-transcript.txt';

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function oneLine(text: string): string {
  return stripThinkTags(text).replace(/\s+/g, ' ').trim();
}

/**
 * The thread as plain text, one line per item: time, who, what. A reply has
 * no time of its own, so it carries the time of its turn. Cards say what they
 * showed, and the steps box the tools that ran. Only what the thread rendered
 * is in it: no keys, tokens or attestation material ever reach an item.
 */
export function buildChatTranscript(items: readonly ChatThreadItem[]): string {
  const lines: string[] = [];
  let lastTime = '';
  const line = (who: string, text: string) => {
    const body = oneLine(text);
    if (!body) return;
    lines.push(`${lastTime ? `${lastTime} ` : ''}${who}: ${body}`);
  };
  for (const item of items) {
    switch (item.kind) {
      case 'message': {
        if (item.message.createdAt) lastTime = clock(item.message.createdAt);
        line(item.message.role === 'user' ? 'You' : 'Mera', item.message.content);
        break;
      }
      case 'agent-steps': {
        const tools = item.steps
          .filter((s) => s.kind === 'tool')
          .map((s) => `${s.toolName ?? s.labelKey} (${s.status})`);
        if (tools.length > 0) line('Mera steps', tools.join(', '));
        if (item.terminal) line('Mera steps', `ended: ${item.terminal}`);
        break;
      }
      case 'fact-card':
        line(`Mera card, ${item.action}`, item.statements.join(' | '));
        break;
      case 'fact-choice-card':
        line(`Mera card, ${item.dismissed ? 'skipped' : 'offer'}`, item.options.join(' | '));
        break;
      case 'ask-choice-card':
        line('Mera asked', `${item.question ?? ''} [${item.options.join(' | ')}]`);
        break;
      case 'chat-topics-card':
      case 'topic-plan-card':
        line('Mera card, topics for', item.factStatement);
        break;
      case 'proposal-card':
        line('Mera card, proposal', `${item.proposal.explanation} ${item.proposal.expectedEffects}`);
        break;
      case 'conflict-card':
        line('Mera card, conflict', JSON.stringify(item.conflict));
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

/**
 * Open the ordinary report form with the disclosure line, and attach the
 * transcript to the report IF the user sends it.
 */
export function openChatBugReport(transcript: string, attachmentNote: string): void {
  const client = Sentry.getClient();
  let dispose = (): void => undefined;
  if (client) {
    // The typed second argument is `options`; at runtime it is the hint that
    // captureFeedback captures with, which is what carries `attachments`.
    dispose = client.on('beforeSendFeedback', (_event: unknown, hint?: unknown) => {
      if (!hint || typeof hint !== 'object') return;
      const h = hint as { attachments?: unknown[] };
      h.attachments = [
        ...(h.attachments ?? []),
        { filename: CHAT_TRANSCRIPT_FILENAME, data: transcript, contentType: 'text/plain' },
      ];
    });
  }
  const unsubscribe = useFeedbackStore.subscribe((state, prev) => {
    if (prev.visible && !state.visible) {
      dispose();
      unsubscribe();
    }
  });
  showFeedback({ attachmentNote });
  // Sentry off: the form never opened, so nothing may stay registered.
  if (!useFeedbackStore.getState().visible) {
    dispose();
    unsubscribe();
  }
}

/** The current thread's items, registered by the mounted chat session so the
 *  popover header can build a transcript without owning the thread. */
let transcriptSource: (() => readonly ChatThreadItem[]) | null = null;

export function registerChatTranscriptSource(source: () => readonly ChatThreadItem[]): () => void {
  transcriptSource = source;
  return () => {
    if (transcriptSource === source) transcriptSource = null;
  };
}

export function currentChatTranscript(): string {
  return transcriptSource ? buildChatTranscript(transcriptSource()) : '';
}
