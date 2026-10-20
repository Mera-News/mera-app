// useChatSessionView: ChatSessionView's logic (thread items, intro, starter chips, block
// state, the send funnel, auto-send and the topic-plan discard reply), moved out of the
// component unchanged. The component draws what this returns.

import { AccountService } from '@/lib/account-service';
import { useChatHistory } from '@/lib/hooks/useChatHistory';
import { loadUserPersona } from '@/lib/database/services/user-persona-service';
import { hapticMedium, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import {
  useFloatingChatProposal,
  useFloatingChatResolvedProposals,
  useFloatingChatQuickFactChecks,
  useFloatingChatToolCallResults,
  useFloatingChatTopicPlanTurnRequest,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { useIsOnDeviceProcessing, useWebSearchInChat } from '@/lib/stores/mera-protocol-store';
import { introKeyFor, pageStarters } from '@/components/custom/mera-button/mera-pages';
import { awaitsFactsRead, usesOriginalWelcome } from './original-welcome';
import { useHasFacts } from '@/components/custom/feed/use-has-facts';
import { useUserStore } from '@/lib/stores/user-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { deriveThreadItems } from './deriveThreadItems';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { decideTopicPlanTurn } from './topic-plan-turn';
import { buildTopicPlanTurnBody } from '@/lib/news-harness/persona-management/topic-plan-notes';
import { getAiAccess } from '@/lib/stores/subscription-store';
import { useTopicPlanResolutions } from './useTopicPlanResolutions';
import type { StarterChip } from './types';
import { renderableTerminal } from './types';
import { HARNESS_TAP_ONLY } from '@/lib/chat-session/cloud-engine-helpers';
import { proposalRequiresUserChoice } from '@/lib/news-harness/core/proposals';
import type { ChatSessionViewProps } from './ChatSessionView';

// `factCheck.chipQuickFactCheck` lands with agent A1's `en.json` splice (see
// this unit's locale fragment); the `t` overloads are generated from en.json, so
// the key is not in the union yet. One cast, no `defaultValue` — an inline
// English default is how English has previously shipped into 19 locale files.
type PendingLocaleKey = 'factCheck.chatSeed';

export function useChatSessionView(props: ChatSessionViewProps) {
  const {
    messages,
    status,
    sendMessage,
    sendHiddenTurn,
    isBlocked,
    blockedReason,
    error,
    context,
    userId,
    conversationId,
    resumeMessages,
    isLoading,
  } = props;
  const { t } = useTranslation();
  const isStreaming = status === 'streaming';

  // TURN-scoped, and deliberately not `status`: the on-device engine sets it
  // idle before its tools run, so a turn still running them would render as
  // interrupted. Undefined until P1's loop writes the
  // state, and the deriver's fallback errs safe: it marks nothing interrupted
  // that is not from an earlier conversation.
  const turnActive = useCloudChatStore((st) => st.agentTurnState?.turnActive);
  const agentTerminal = useCloudChatStore((st) => renderableTerminal(st.agentTerminal));
  const resume = useMemo(() => resumeMessages ?? [], [resumeMessages]);

  // The turn's lifecycle (the restart hold, persistence, the busy and
  // unread flags) lives in the chat session (lib/chat-session), not here:
  // this view may unmount mid-turn.

  // Intro copy depends on the context: the article-feedback surfaces open with a
  // "what can I do for you" line (article vs. suggestion variant); everything
  // else keeps the persona intro.
  const webSearch = useWebSearchInChat();
  // The claim picker is CLOUD-only — `proposeFactCheck` is neither declared nor
  // described in the LOCAL prompt (its rules are ~1,200 tokens against a ~3,072
  // budget, and the check needs the cloud regardless). A chip offering it in
  // on-device mode would send a turn to an agent with no such tool, which is the
  // exact silent mis-wire the `generic` and `follow-story` branches below already
  // exist to prevent. Same signal the agent reads, so the three gates agree.
  const isOnDevice = useIsOnDeviceProcessing();
  // Computed keys from the page table, so `t` takes them untyped (the
  // en.json presence test in mera-button covers every one).
  const tKey = t as unknown as (key: string, opts?: Record<string, string>) => string;
  // Whether the reader had facts when the chat opened, frozen at the first
  // answer: a fact saved during the chat must not swap the welcome under them.
  const hasFacts = useHasFacts();
  const [factsAtOpen, setFactsAtOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (factsAtOpen === null && hasFacts !== null) setFactsAtOpen(hasFacts);
  }, [factsAtOpen, hasFacts]);
  const originalWelcome = usesOriginalWelcome(context, factsAtOpen);
  const awaitingFacts = awaitsFactsRead(context, factsAtOpen);
  const introText = awaitingFacts
    ? null
    : context.kind === 'optimisation-plan'
      ? // The pinned plan card IS the content — no persona intro line beneath it.
        null
      : (context.kind === 'persona' || context.kind === 'follow-story') &&
          context.page &&
          !originalWelcome
        ? // Opened from the Mera button: the page's own first line.
          tKey(introKeyFor(context.page, webSearch && !isOnDevice, isOnDevice))
        : context.kind === 'follow-story'
          ? // The FAB seeds "I want to follow a story", so the persona intro
            // ("tell me about yourself…") would answer a question nobody asked.
            t('trackedStories.followChatIntro')
          : context.kind === 'generic'
            ? // Route-aware product help (today: "Ask Mera" on a tutorial slide).
              // The persona intro ("tell me about yourself so I can tune your feed")
              // would be an outright lie here — TutorialHelpAgent has no tools and
              // cannot tune anything. The button also always seeds a question, so
              // this line is only ever briefly visible.
              t('tutorials.chatIntro')
            : context.kind === 'article-suggestion'
              ? context.verdict === 'like'
                ? t('articleFeedback.introLikeTuning')
                : context.verdict === 'dislike'
                  ? t('articleFeedback.introDislikeTuning')
                  : t(
                      context.suggestionId
                        ? 'articleFeedback.intro'
                        : 'articleFeedback.introArticle',
                    )
              : t('personaChat.introMessage');

  // On this phone is Beta (D30), and its intro says so in words: a chat bubble cannot draw the badge.
  const introShown = introText && isOnDevice ? `${introText}\n\n${t('chat.onDeviceBetaNote')}` : introText;

  // Intro pseudo-message until the first send of this session.
  const [introCleared, setIntroCleared] = useState(false);
  const introMessage = introCleared ? null : introShown;

  // Lazily page in older history on scroll-up.
  const { history, loadOlder, hasOlder, isLoadingOlder } = useChatHistory(
    conversationId ?? undefined,
  );

  // Pin the subject article at the top of an article-suggestion thread.
  const articleContext = useMemo(
    () =>
      context.kind === 'article-suggestion'
        ? {
            articleId: context.articleId,
            suggestionId: context.suggestionId,
            title: context.articleTitle ?? '',
          }
        : undefined,
    [context],
  );

  // Pin the interactive optimisation-plan card at the top of a plan thread.
  const optimisationPlan = useMemo(
    () => (context.kind === 'optimisation-plan' ? { key: 'optimisation-plan' } : undefined),
    [context],
  );

  // Quick fact checks live in the store, not in the message stream: no model
  // turn produces one (the user taps a claim pill and the check runs off-model),
  // and they are deliberately never persisted — a quick answer is a snapshot of
  // what the web said at that moment, not a stored verdict.
  const quickFactChecks = useFloatingChatQuickFactChecks();
  const toolCallResults = useFloatingChatToolCallResults();

  // The live tool and retry flag, for the steps box's live row and the typing
  // item. The strip subscribes to its own state, so none of it lands in items.
  const liveTool = useChatPhaseStore((st) => st.liveTool);
  const retriedThisTurn = useChatPhaseStore((st) => st.retriedThisTurn);
  const engine = isOnDevice ? 'local' : 'cloud';

  const items = useMemo(
    () =>
      deriveThreadItems({
        live: messages,
        history,
        introMessage,
        isStreaming,
        earlierConversationLabel: t('floatingChat.earlierConversation'),
        resume,
        articleContext,
        optimisationPlan,
        quickFactChecks,
        toolCallResults,
        turnActive,
        agentTerminal,
        engine,
        liveTool,
        retriedThisTurn,
      }),
    [
      engine,
      liveTool,
      retriedThisTurn,
      messages,
      history,
      introMessage,
      isStreaming,
      t,
      resume,
      articleContext,
      optimisationPlan,
      quickFactChecks,
      toolCallResults,
      turnActive,
      agentTerminal,
    ],
  );

  // r14 — topic-plan gate. Every unresolved "Topics I'll track" card in the
  // thread blocks the chat input, so the user can't walk away from a plan they
  // never chose to keep or discard.
  //
  // Resolution is NOT the in-memory store map: cards re-derive from a persisted
  // tool result, so gating on the map alone would re-block the user after every
  // relaunch. useTopicPlanResolutions combines it with the durable markers and
  // fails open while the facts read is in flight. See topic-plan-resolution.ts.
  const topicPlanFactIds = useMemo(
    () =>
      items
        .filter((item) => item.kind === 'topic-plan-card')
        .map((item) => (item as Extract<typeof item, { kind: 'topic-plan-card' }>).factId),
    [items],
  );
  const { unresolved: unresolvedTopicPlans } = useTopicPlanResolutions(topicPlanFactIds);

  // Propose-before-save gate. A fact-choice card is unanswered until its tool
  // result has been rewritten by a commit or a dismissal, and it blocks the
  // input for the same reason a topic plan does: the user must not walk away
  // from a question Mera is still holding open.
  //
  // STALE cards are excluded. A card derived from an EARLIER conversation can
  // never be committed, so counting it would let "View previous messages"
  // re-block the composer with no way to clear it.
  // Counted from the card's OWN state, not from "is there a value at
  // resultKey". That older test was shared by every sibling card of a tool
  // call, so one tap cleared the gate for all of them — the same shape as the
  // bug that made one tap delete every sibling card. A dismissed card is
  // resolved and does not count; its Undo returns it to pending and re-blocks,
  // which is correct because an unanswered question is unanswered again.
  const unresolvedFactChoices = useMemo(
    () =>

      items.filter(
        (item) => item.kind === 'fact-choice-card' && !item.stale && !item.dismissed,
      ).length,
    [items],
  );

  const hasUnresolvedTopicPlans = unresolvedTopicPlans.length > 0 || unresolvedFactChoices > 0;

  // Publish the count so surfaces OUTSIDE this component — the onboarding
  // wizard's Next button — gate on the same signal. Without this the input is
  // disabled while Next sails straight past it, which makes the block
  // decorative. Cleared on unmount: a block that outlives its cards is
  // unclearable.
  useEffect(() => {
    useFloatingChatStore.getState().setUnresolvedTopicPlanCount(unresolvedTopicPlans.length);
  }, [unresolvedTopicPlans.length]);
  useEffect(() => {
    useFloatingChatStore.getState().setUnresolvedFactChoiceCount(unresolvedFactChoices);
  }, [unresolvedFactChoices]);
  useEffect(
    () => () => {
      useFloatingChatStore.getState().setUnresolvedTopicPlanCount(0);
      useFloatingChatStore.getState().setUnresolvedFactChoiceCount(0);
      // A nonce that outlives its thread would fire a "you rejected my topics"
      // reply into whatever conversation mounts next.
      useFloatingChatStore.getState().clearTopicPlanTurnRequest();
    },
    [],
  );

  // Success haptic when a new fact card lands in the LIVE session. History
  // cards are excluded so paging in old conversations doesn't buzz.
  const liveFactCardCount = useMemo(

    () =>
      items.filter((item) => item.kind === 'fact-card' && item.key.startsWith('card-')).length,
    [items],
  );
  const prevFactCardCountRef = useRef(0);
  useEffect(() => {
    if (liveFactCardCount > prevFactCardCountRef.current) {
      void hapticSuccess();
    }
    prevFactCardCountRef.current = liveFactCardCount;
  }, [liveFactCardCount]);

  const starterChips: StarterChip[] = useMemo(() => {
    // The optimisation-plan thread is card-only — no persona/article chips.
    if (context.kind === 'optimisation-plan' || awaitingFacts) return [];
    // Opened from the Mera button: the page's hints as starters that fill the
    // composer and never send (owner ruling, navx).
    if (
      (context.kind === 'persona' || context.kind === 'follow-story') &&
      context.page &&
      !originalWelcome
    ) {
      const subject = context.kind === 'persona' ? context.subject : undefined;
      return pageStarters(context.page, webSearch, subject, isOnDevice).map((s) => ({
        key: s.labelKey,
        label: tKey(s.labelKey),
        message: tKey(s.draftKey, s.draftOptions ? { ...s.draftOptions } : undefined),
        draft: true,
      }));
    }
    // The follow-story thread opens with an auto-sent turn and expects the user
    // to describe what they want followed — persona chips ("add a place", "show
    // my facts") would derail it into a chat that has no tools for them.
    if (context.kind === 'follow-story') return [];
    // Product-help thread. The persona chips below ("add where I live", "show my
    // facts", "help me set up") all expect an agent with fact tools; offering
    // them here would advertise actions TutorialHelpAgent cannot take, which is
    // the same silent mis-wire the agent itself exists to prevent.
    if (context.kind === 'generic') return [];
    if (context.kind === 'article-suggestion') {
      // A real suggestion can be explained ("why?"); a plain article can't, so
      // it offers "more like this" instead. Both offer the "don't want" chip.
      const firstChip: StarterChip = context.suggestionId
        ? {
            key: 'why',
            label: t('articleFeedback.chipWhy'),
            message: t('articleFeedback.chipWhyMessage'),
          }
        : {
            key: 'more-like-this',
            label: t('articleFeedback.chipMoreLikeThis'),
            message: t('articleFeedback.chipMoreLikeThisMessage'),
          };
      return [
        firstChip,
        // The QUICK path's entry point. `factCheck.chatSeed` is deliberately the
        // SAME key the article action-row tick seeds with
        // (FACT_CHECK_SEED_MESSAGE_KEY in fact-check-state.ts), so the two
        // affordances open the identical turn by construction rather than by two
        // strings someone has to keep in step.
        ...(isOnDevice
          ? []
          : [
              {
                key: 'quick-fact-check',
                label: t('factCheck.chipQuickFactCheck' as PendingLocaleKey),
                message: t('factCheck.chatSeed'),
              },
            ]),
        {
          key: 'dont-want',
          label: t('articleFeedback.chipDontWant'),
          message: t('articleFeedback.chipDontWantMessage'),
        },
      ];
    }
    return [
      {
        key: 'add-location',
        label: t('floatingChat.chipAddLocation'),
        message: t('floatingChat.chipAddLocationMessage'),
      },
      {
        key: 'show-facts',
        label: t('floatingChat.chipShowFacts'),
        message: t('floatingChat.chipShowFactsMessage'),
      },
      {
        key: 'help-setup',
        label: t('floatingChat.chipHelpSetup'),
        message: t('floatingChat.chipHelpSetupMessage'),
      },
      // The intro invites "ask me how that works" — this makes that invitation
      // tappable. Routes to the explainMera tool like any typed question would.
      {
        key: 'data-handling',
        label: t('floatingChat.chipDataHandling'),
        message: t('floatingChat.chipDataHandlingMessage'),
      },
    ];
  }, [t, tKey, context, isOnDevice, webSearch, originalWelcome, awaitingFacts]);

  // --- Server-authoritative block state ---------------------------------
  // The hook's `isBlocked` only flips mid-session (via an issueWarning side
  // effect). To keep a block sticky across app restarts we ALSO seed from the
  // persisted persona on mount, and let the refresh button re-derive it. The
  // effective gate is the OR of the two: within a single session a user can only
  // go unblocked→blocked, so a stale live flag is never a concern.
  const [personaBlock, setPersonaBlock] = useState<{ blocked: boolean; reason: string | null }>({
    blocked: false,
    reason: null,
  });
  const [unblockPending, setUnblockPending] = useState(false);
  const [unblockChecked, setUnblockChecked] = useState(false);
  const [isRefreshingBlockStatus, setIsRefreshingBlockStatus] = useState(false);
  const [unblockModalOpen, setUnblockModalOpen] = useState(false);

  // Seed from the persisted persona (store first, WatermelonDB fallback) so a
  // block from a prior session still gates the input on reopen.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      let persona = useUserStore.getState().userPersona;
      if (!persona || persona.userId !== userId) {
        persona = await loadUserPersona(userId).catch(() => null);
      }
      if (!cancelled && persona) {
        setPersonaBlock({
          blocked: persona.blockedByLlm,
          reason: persona.blockedByLlmReason ?? null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const effectiveBlocked = isBlocked || personaBlock.blocked;
  const effectiveBlockedReason = blockedReason || personaBlock.reason;

  // --- Discard → Mera replies ------------------------------------------------
  //
  // A discarded topic plan is the user rejecting a suggestion, and they are owed
  // a response. The card only REQUESTS (a nonce); the decision of when it may
  // fire is `decideTopicPlanTurn`, kept pure and unit-tested because every rule
  // in it fails invisibly. All of its inputs are in the dep array, which is what
  // lets a request parked behind an unresolved sibling card fire once the gate
  // finally clears — and what makes "Discard all" produce exactly ONE turn.
  const topicPlanTurnRequest = useFloatingChatTopicPlanTurnRequest();
  const lastFiredTurnRef = useRef<number | null>(null);
  useEffect(() => {
    const decision = decideTopicPlanTurn({
      request: topicPlanTurnRequest,
      lastFired: lastFiredTurnRef.current,
      unresolvedCount: unresolvedTopicPlans.length + unresolvedFactChoices,
      isStreaming,
      blocked: effectiveBlocked,
      aiLocked: getAiAccess() === 'locked',
    });
    if (decision === 'wait') return;

    const store = useFloatingChatStore.getState();
    if (decision === 'drop') {
      // Keep the NOTES — they still belong in <context> on the next real turn.
      // Only the proactive reply is abandoned.
      store.clearTopicPlanTurnRequest();
      return;
    }

    const body = buildTopicPlanTurnBody(store.topicPlanNotes, { compact: isOnDevice });
    if (!body) {
      store.clearTopicPlanTurnRequest();
      return;
    }
    // Set ONLY on the fire path: marking it on an early return would silently
    // kill the mechanism for the rest of the session.
    lastFiredTurnRef.current = topicPlanTurnRequest;
    store.clearTopicPlanTurnRequest();
    store.setTopicPlanTurnInFlight(true);
    setIntroCleared(true);
    sendHiddenTurn(body);
  }, [
    topicPlanTurnRequest,
    unresolvedTopicPlans.length,
    unresolvedFactChoices,
    isStreaming,
    effectiveBlocked,
    isOnDevice,
    sendHiddenTurn,
  ]);

  // Once blocked, check (once) whether a request is already PENDING so we show
  // "Pending Review" instead of the "Request Unblock" CTA.
  useEffect(() => {
    if (!effectiveBlocked || !userId || unblockChecked) return;
    setUnblockChecked(true);
    AccountService.getPendingUnblockRequest(userId)
      .then((req) => {
        if (req && req.status === 'PENDING') setUnblockPending(true);
      })
      .catch((err) =>
        logger.warn('[ChatSessionView] pending unblock check failed', { error: String(err) }),
      );
  }, [effectiveBlocked, userId, unblockChecked]);

  // The only way a user learns staff lifted the block in v1 (no push-back):
  // re-fetch the persona, persist it, and clear the local gate if now unblocked.
  const handleRefreshBlockStatus = useCallback(async () => {
    if (!userId || isRefreshingBlockStatus) return;
    setIsRefreshingBlockStatus(true);
    try {
      const persona = await useUserStore.getState().fetchUserPersona(userId, true);
      if (persona) {
        setPersonaBlock({
          blocked: persona.blockedByLlm,
          reason: persona.blockedByLlmReason ?? null,
        });
        if (!persona.blockedByLlm) setUnblockPending(false);
      }
    } catch (err) {
      logger.warn('[ChatSessionView] refresh block status failed', { error: String(err) });
    } finally {
      setIsRefreshingBlockStatus(false);
    }
  }, [userId, isRefreshingBlockStatus]);

  const handleUnblockSubmitted = useCallback(() => {
    setUnblockPending(true);
  }, []);

  const handleSend = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || effectiveBlocked) return;
      // Disabling PromptInput is not enough: the auto-send effect below and the
      // starter chips both call this directly, bypassing the input entirely.
      // Only the legacy topic-plan card gates here: a waiting FACT card takes a
      // typed answer, and the card stays pending beside it (audit F7).
      if (unresolvedTopicPlans.length > 0) return;
      void hapticMedium();
      setIntroCleared(true);
      sendMessage(trimmed);
    },
    [isStreaming, effectiveBlocked, unresolvedTopicPlans.length, sendMessage],
  );

  // Chips send their canned message through the same path (haptic included).
  const handleChipPress = useCallback(
    (message: string) => {
      handleSend(message);
    },
    [handleSend],
  );

  // Auto-send the pending initial message once per session (thumbs tap on an
  // article detail screen seeds it). The atomic consume + ref guard ensures it
  // fires exactly once even across re-renders; a fresh conversationId remounts
  // this view for each new thumbs tap, resetting the ref. Bubble-tap opens set
  // no pending message, so this is a no-op there (intro + chips show instead).
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (isLoading || isStreaming || autoSentRef.current) return;
    // Checked BEFORE consuming: `consumePendingInitialMessage` clears the store
    // slot, so consuming into a handleSend that then drops the text would lose
    // the message outright rather than deferring it.
    if (hasUnresolvedTopicPlans) return;
    const pending = useFloatingChatStore.getState().consumePendingInitialMessage();
    if (pending) {
      autoSentRef.current = true;
      handleSend(pending);
    }
  }, [isLoading, isStreaming, hasUnresolvedTopicPlans, handleSend]);

  // "View previous messages" gate: history stays hidden until the user reveals
  // it, at which point the normal scroll-up paging resumes.
  const [historyRevealed, setHistoryRevealed] = useState(false);
  const handleRevealHistory = useCallback(() => {
    setHistoryRevealed(true);
    loadOlder();
  }, [loadOlder]);

  // Surface inference errors directly — there's no recovery action the user
  // can take in-app (ported from PersonaChatUI). A server block always shows a
  // banner even when the reason is null, so the unblock controls have a host.
  // Ordering is deliberate: a server block outranks an inference error, and both
  // outrank the topic-plan gate — the gate is a soft "finish this first", not a
  // failure, so it must never mask a real error the user needs to see.
  // Which of the banner's three causes may also gate the composer. A
  // transport error is deliberately absent: it clears when a turn starts, so
  // blocking the input on it is a deadlock, not a safeguard.
  // A waiting FACT card does not gate the composer any more (audit F7): the
  // red "Pick a reading" banner showed before the user had done anything, and
  // a typed answer is a legitimate answer. It leaves the card pending and a
  // neutral hint says so. The legacy topic-plan card keeps its gate.
  const bannerBlocksInput = effectiveBlocked || unresolvedTopicPlans.length > 0;
  // A waiting CARD (proposal) is a hint too. The fact-card hint wins when both
  // apply: it is the older, more specific one.
  const storeProposal = useFloatingChatProposal();
  const resolvedProposals = useFloatingChatResolvedProposals();
  const lastProposalCard = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'proposal-card') return it;
    }
    return null;
  }, [items]);
  const proposalCardWaiting =
    storeProposal !== null &&
    lastProposalCard !== null &&
    resolvedProposals[lastProposalCard.proposal.id] === undefined;
  // "or type yes" only where a typed yes can apply the card: cloud, one option,
  // nothing tap-only. Anywhere else the hint must not invite a yes that does
  // nothing.
  const typedYesApplies =
    storeProposal !== null &&
    !isOnDevice &&
    !proposalRequiresUserChoice(storeProposal) &&
    !storeProposal.actions.some((a) => HARNESS_TAP_ONLY.has(a.type));
  const composerHint =
    unresolvedFactChoices > 0
      ? t('factChoice.pendingHint')
      : proposalCardWaiting
        ? typedYesApplies
          ? t('floatingChat.cardWaitingHint')
          : t('floatingChat.cardTapHint')
        : null;

  // A card resolved by TYPING (the turn carried applyProposal or cancelProposal)
  // is announced; a button tap is not, it already speaks for itself. The store
  // entry can land before the turn's tool-call record does, so an entry waits
  // for its call, and only within the user turn it appeared in.
  const userTurns = messages.filter((m) => m.role === 'user' && !m.hidden).length;
  const seenResolvedRef = useRef<Record<string, number> | null>(null);
  useEffect(() => {
    if (seenResolvedRef.current === null) {
      // First run: whatever is already resolved was resolved before this view.
      seenResolvedRef.current = Object.fromEntries(
        Object.keys(resolvedProposals).map((id) => [id, -1]),
      );
      return;
    }
    const seen = seenResolvedRef.current;
    let lastUser = -1;
    messages.forEach((m, i) => {
      if (m.role === 'user' && !m.hidden) lastUser = i;
    });
    const turnCalls = new Set(
      messages
        .slice(lastUser + 1)
        .flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.name)),
    );
    for (const [id, status] of Object.entries(resolvedProposals)) {
      if (!(id in seen)) seen[id] = userTurns;
      if (seen[id] !== userTurns) continue;
      const call = status === 'applied' ? 'applyProposal' : 'cancelProposal';
      if (!turnCalls.has(call)) continue;
      seen[id] = -1;
      void AccessibilityInfo.announceForAccessibility(
        status === 'applied'
          ? t('articleFeedback.proposalApplied')
          : t('floatingChat.cardCancelled'),
      );
    }
  }, [resolvedProposals, messages, userTurns, t]);

  const blockedMessage = effectiveBlocked
    ? (effectiveBlockedReason || t('errors.accountRestricted'))
    : error
      ? // The raw error string is NOT appended. It is a bare string with no class
        // to branch on, and what it carried was the provider's own English JSON
        // (`{"error":{"message":"Provider failed for model ...: Decryption
        // failed"}}`), rendered verbatim to users in every locale — MERA-APP-72
        // caught it on a Portuguese device. `chat.inferenceError` already tells
        // the user to try again in a moment, which is the only action available.
        // Status and body stay on the cloudComplete breadcrumb for triage.
        t('chat.inferenceError')
      : unresolvedTopicPlans.length > 0
        ? t('topicPlan.resolveBeforeContinuing')
        : null;

  return {
    t,
    isStreaming,
    items,
    loadOlder,
    hasOlder,
    isLoadingOlder,
    historyRevealed,
    handleRevealHistory,
    starterChips,
    handleChipPress,
    blockedMessage,
    bannerBlocksInput,
    effectiveBlocked,
    unblockPending,
    unblockModalOpen,
    setUnblockModalOpen,
    handleRefreshBlockStatus,
    isRefreshingBlockStatus,
    handleSend,
    composerHint,
    handleUnblockSubmitted,
    introMessage,
    unresolvedTopicPlans,
    unresolvedFactChoices,
  };
}
