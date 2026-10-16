// Module-level helpers of the cloud chat engine (createCloudEngine in
// lib/hooks/useCloudPersonaChat.ts). Not pure: stores, i18n and settings.

import logger from '../logger';
import type { WireMessage } from '@/lib/llm/cloudComplete';
import type { ConversationMessage } from '../llm/types';
import type { AgentDeps, AgentState, PendingProposalView } from '../mera-harness';
import type { ToolExecutionResult } from '../news-harness/core/types';
import { proposalRequiresUserChoice } from '../news-harness/core/proposals';
import { useCloudChatStore } from '../stores/cloud-chat-store';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { unresolvedGroups } from '../chat-tools/fact-choice-resolution';
import { estimateTokens } from '../algorithms/estimate-tokens';

/**
 * The one-time split offer for a combined "origin plus residence" fact is
 * remembered on the device, so a skipped offer is not repeated on every later
 * residence or origin turn. Stored as a JSON list of fact ids.
 */
const COMBINED_SPLIT_OFFERED_KEY = 'mera_combined_fact_split_offered_v1';

/**
 * Required LAZILY, on purpose. `setting-service` builds its collection at
 * module scope, so a top-level import here constructs a real SQLiteAdapter the
 * moment anything imports this hook, and every suite that renders it dies at
 * load with `initializeJSI`.
 */
function settings(): typeof import('../database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../database/services/setting-service');
}

async function readSplitOffered(): Promise<string[]> {
  try {
    const raw = await settings().getSetting(COMBINED_SPLIT_OFFERED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function withCombinedFactMemory(deps: AgentDeps): AgentDeps {
  return {
    ...deps,
    combinedFactRewrite: {
      wasOffered: async (factId) => (await readSplitOffered()).includes(factId),
      markOffered: async (factId) => {
        const ids = await readSplitOffered();
        if (ids.includes(factId)) return;
        await settings()
          .setSetting(COMBINED_SPLIT_OFFERED_KEY, JSON.stringify([...ids, factId]))
          .catch(() => {});
      },
    },
  };
}

/**
 * Every reading on a fact-choice card in this thread that the user has not
 * answered. The store holds the tool call's staged result; a tap writes an
 * OVERRIDE under `${messageId}::${index}` in the floating-chat store, which
 * wins when present.
 */
export function pendingCardStatements(messages: ConversationMessage[]): string[] {
  const overrides = useFloatingChatStore.getState().toolCallResults;
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    m.toolCalls.forEach((tc, idx) => {
      if (tc.name !== 'saveExtractedFacts') return;
      const result = overrides[`${m.id}::${idx}`] ?? (tc.result as Record<string, unknown> | undefined);
      for (const g of unresolvedGroups(result)) out.push(...g.options);
    });
  }
  return out;
}

/**
 * What a tool's execution asks the chat to do: block it, stage a card, settle
 * the waiting card. ONE place for both the single-shot path and the harness
 * card tools. `cloud` is the engine's own (possibly detached) store handle; the
 * floating-chat writes are skipped once the engine is disposed.
 */
export function applyToolSideEffects(
  sideEffects: ToolExecutionResult['sideEffects'],
  { alive, cloud = useCloudChatStore.getState() }: { alive: boolean; cloud?: CloudState },
): void {
  if (!sideEffects) return;
  if (sideEffects.blocked) {
    cloud.setIsBlocked(true);
    cloud.setBlockedReason(sideEffects.blocked.reason);
  }
  if (sideEffects.proposal && alive) useFloatingChatStore.getState().setProposal(sideEffects.proposal);
  if (sideEffects.proposalResolved && alive) {
    useFloatingChatStore.getState().resolveProposal(sideEffects.proposalResolved);
  }
}

/**
 * Actions a typed "yes" must never apply: they skip the loop's save
 * normalisation, the M6 delete gate, mayReplace and the topic veto. Only the
 * card's tap runs those paths.
 */
export const HARNESS_TAP_ONLY: ReadonlySet<string> = new Set([
  'run_calibration',
  'fact_check_claim',
  'add_fact',
  'update_fact',
  'delete_fact',
  'add_topics',
  'remove_topics',
]);

/** The card on screen, as the loop sees it; null once it is settled or absent. */
export function pendingProposalView(): PendingProposalView | null {
  const { proposal: p, resolvedProposals } = useFloatingChatStore.getState();
  if (!p || resolvedProposals[p.id]) return null;
  const chooseOne = proposalRequiresUserChoice(p);
  return {
    id: p.id,
    summary: p.explanation || p.actions.map((a) => (a as { label?: string }).label ?? a.type).join(', '),
    chooseOne,
    appliable: !chooseOne && !p.actions.some((a) => HARNESS_TAP_ONLY.has(a.type)),
  };
}

/** The user's active filters for the loop's state; best effort. */
export async function activeFiltersView(): Promise<NonNullable<AgentState['activeFilters']>> {
  try {
    // Lazy: the suppression service builds its collection at module scope.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rows = await (require('../database/services/suppression-service') as typeof import('../database/services/suppression-service')).getActive();
    return rows.map((r) => ({ id: r.id, pattern: r.pattern }));
  } catch {
    return [];
  }
}

/** Tool arguments arrive as a JSON string. A malformed one must yield an empty
 *  object rather than throwing: this runs inside the live progress write-back,
 *  and a throw there would kill the turn over a cosmetic row. */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Required lazily: lib/i18n pulls the OS translator's native module at load. */
function i18nInstance(): typeof import('../i18n').default {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../i18n') as typeof import('../i18n')).default;
}

const TAG = '[CloudChat]';

type CloudState = ReturnType<typeof useCloudChatStore.getState>;

/** The store's state with every action a no-op: what a disposed engine writes to. */
function detachedCopy(state: CloudState): CloudState {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) copy[key] = typeof value === 'function' ? () => {} : value;
  return copy as unknown as CloudState;
}

/** Next-frame scheduler for the streaming bubble. RN provides
 *  requestAnimationFrame; the timeout fallback keeps the hook usable under a
 *  test runtime without it. */
const scheduleFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(cb);
  } else {
    setTimeout(cb, 16);
  }
};

// Cloud chat carries a TOKEN-BUDGETED window of recent turns (see
// lib/news-harness/persona-management/history-window.ts). It used to send only
// the current user turn, which meant a tail of [..., user("Yes")] reached the
// model as the bare word "Yes" with no trace of the question it answered — the
// reported bug where Mera responded to a confirmation with "Great, good to see
// you again!".
//
// Fresh facts are still re-loaded from the `facts` table every turn via
// buildContext() and injected onto the LAST user message only, so a wider
// window never lets the LLM hallucinate persisted state from a stale assistant
// claim like "Got it, saved" — the facts block always reflects the database,
// not the conversation.
function wireMessageTokens(m: WireMessage): number {
  const content = typeof m.content === 'string' ? m.content : '';
  const calls =
    'tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls) : '';
  return estimateTokens(content) + estimateTokens(calls);
}

// ---------------------------------------------------------------------------
// Accumulate tool-call deltas by index into complete tool calls
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

interface FinalizedToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Set when the model's argument JSON could not be parsed. Such a call is
   *  NEVER executed and never reaches the wire — see the note below. */
  malformed?: true;
}

function finalizeToolCalls(
  accumulators: Map<number, ToolCallAccumulator>,
): FinalizedToolCall[] {
  const results: FinalizedToolCall[] = [];
  for (const [, acc] of accumulators) {
    if (!acc.name) continue;
    try {
      const input = acc.arguments ? JSON.parse(acc.arguments) : {};
      results.push({ id: acc.id, name: acc.name, input });
    } catch {
      // Do NOT substitute `{}`. That turned a truncated or corrupt call into a
      // well-formed one with no arguments, which the handlers then answered as
      // an ordinary validation failure ("fact_ids must be a non-empty array") —
      // telling the model its ARGUMENTS were wrong when in fact its
      // SERIALIZATION was, and making a dropped call look like a successful
      // no-op in the logs.
      logger.warn(`${TAG} Failed to parse tool call arguments`, {
        name: acc.name,
        // Lengths only: the arguments are the user's facts, and a warning is a
        // Sentry breadcrumb in production.
        argsLength: acc.arguments.length,
      });
      logger.captureMessage(`${TAG} malformed tool arguments`, {
        level: 'warning',
        tags: { component: 'useCloudPersonaChat' },
        extra: { tool: acc.name, argsLength: acc.arguments.length },
      });
      results.push({ id: acc.id, name: acc.name, input: null, malformed: true });
    }
  }
  return results;
}

export {
  withCombinedFactMemory,
  parseToolArgs,
  i18nInstance,
  TAG,
  detachedCopy,
  scheduleFrame,
  wireMessageTokens,
  finalizeToolCalls,
};
export type { CloudState, ToolCallAccumulator };
