// Shared kit for the fact-tool seam tests. Not a test file (Jest matches *.test.ts only).
//
// Reads back through the app's own services where one exists. The queue table has no list read
// (only a head read), so `queuedJobs` queries the collection read-only.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import { getFacts } from '@/lib/database/services/fact-service';
import { createConversation, appendMessage } from '@/lib/database/services/conversation-service';
import type InferenceJob from '@/lib/database/models/InferenceJob';
import type { InferenceJobType } from '@/lib/database/models/InferenceJob';
import { handleSaveExtractedFacts } from '@/lib/chat-tools/tool-handlers';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import type { ChatThreadItem } from '@/components/custom/floating-chat/types';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { graphql } from 'msw';

/** Rows of the persisted inference queue, oldest first. */
export async function queuedJobs(type?: InferenceJobType): Promise<{ type: string; status: string; payload: Record<string, unknown> }[]> {
  const rows = await database
    .get<InferenceJob>('inference_jobs')
    .query(...(type ? [Q.where('job_type', type)] : []), Q.sortBy('created_at', Q.asc))
    .fetch();
  return rows.map((r) => ({ type: r.jobType, status: r.status, payload: r.payload }));
}

/** The stored fact with exactly this statement. */
export const factNamed = async (statement: string) => {
  const fact = (await getFacts()).find((f) => f.statement === statement);
  if (!fact) throw new Error(`no fact: ${statement}`);
  return fact;
};

export const factStatements = async (): Promise<string[]> => (await getFacts()).map((f) => f.statement);

/** Lets fire-and-forget writes (the durable message patch, the geo sweep) land. */
export const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

export { createConversation, appendMessage };

/** Polls an async read on real timers until `done` holds for its value; returns the last value. */
export async function pollUntil<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  let value = await read();
  for (let t = 0; t < ms && !done(value); t += 25) {
    await settle(25);
    value = await read();
  }
  return value;
}

// ---- the fact-choice cards: stage a turn, derive its thread, tap ------------------------------

export const MSG = 'asst-1';

export type ItemOf<K extends ChatThreadItem['kind']> = Extract<ChatThreadItem, { kind: K }>;

/** The thread the UI would draw for one assistant message holding one `saveExtractedFacts` call,
 *  with the store's live overrides applied (the way ChatThread passes them). */
export function threadFor(staged: Record<string, unknown>, opts: { followedByUser?: boolean } = {}): ChatThreadItem[] {
  return deriveThreadItems({
    live: [
      {
        id: MSG,
        role: 'assistant',
        content: 'Noted. Which topics do you want in your feed most?',
        toolCalls: [{ id: 'tc-0', name: 'saveExtractedFacts', status: 'done', input: {}, result: staged }],
      },
      ...(opts.followedByUser ? [{ id: 'user-2', role: 'user' as const, content: 'ok' }] : []),
    ],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
    toolCallResults: useFloatingChatStore.getState().toolCallResults,
  });
}

/** Card sequence, with the per-turn steps box left out (it has its own suite). */
export const kindsOf = (items: ChatThreadItem[]): string[] =>
  items.filter((i) => i.kind !== 'agent-steps').map((i) => i.kind);

export const cardsOf = (items: ChatThreadItem[]) => items.filter((i): i is ItemOf<'fact-choice-card'> => i.kind === 'fact-choice-card');
export const bulkOf = (items: ChatThreadItem[]) => items.find((i): i is ItemOf<'fact-choice-bulk-row'> => i.kind === 'fact-choice-bulk-row');

/** Stages `facts` through the real handler and persists the assistant message the way the chat
 *  session does (same id as the in-memory message), so a durable patch has a row to land on. */
export async function stageTurn(facts: unknown[]) {
  const staged = await handleSaveExtractedFacts({ extracted_user_information: facts });
  const conversationId = await createConversation('CONFIG');
  await appendMessage(
    conversationId,
    { role: 'assistant', content: 'Noted.', toolCalls: [{ id: 'tc-0', name: 'saveExtractedFacts', status: 'done', input: {}, result: staged }] },
    MSG,
  );
  return { staged, conversationId, key: `${MSG}::0` };
}

// ---- recording a GraphQL operation without answering it ---------------------------------------

/** Records the variables of every call to `operationName` and lets the default handler answer. */
export function recordGql(operationName: string): { calls: Record<string, any>[]; handler: ReturnType<typeof graphql.operation> } {
  const calls: Record<string, any>[] = [];
  const handler = graphql.operation(({ operationName: name, variables }) => {
    if (name === operationName) calls.push(variables as Record<string, any>);
    return undefined;
  });
  return { calls, handler };
}
