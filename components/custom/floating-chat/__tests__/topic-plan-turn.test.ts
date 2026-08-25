// decideTopicPlanTurn — WHEN a discard may make Mera reply.
//
// This function exists because the decision fails INVISIBLY. Fire too early and
// `handleSend`'s gate swallows the turn with no error; park a nonce too long and
// it fires into a conversation the user has already left. Neither shows up in
// the UI, and there is no ChatSessionView test to catch it in the effect.

import { decideTopicPlanTurn } from '../topic-plan-turn';

const base = {
  request: 100 as number | null,
  lastFired: null as number | null,
  unresolvedCount: 0,
  isStreaming: false,
  blocked: false,
  aiLocked: false,
};

describe('decideTopicPlanTurn', () => {
  it('waits when nothing has been requested', () => {
    expect(decideTopicPlanTurn({ ...base, request: null })).toBe('wait');
  });

  it('waits when this exact request already fired', () => {
    expect(decideTopicPlanTurn({ ...base, request: 100, lastFired: 100 })).toBe('wait');
  });

  it('fires a fresh request on a clear gate', () => {
    expect(decideTopicPlanTurn({ ...base, request: 101, lastFired: 100 })).toBe('fire');
  });

  it('waits while any card is still unanswered', () => {
    expect(decideTopicPlanTurn({ ...base, unresolvedCount: 1 })).toBe('wait');
  });

  it('waits while a turn is already streaming', () => {
    expect(decideTopicPlanTurn({ ...base, isStreaming: true })).toBe('wait');
  });

  // DROP, not wait. A block is not transient — parking it would fire a "you
  // rejected my topics" reply days later, on unblock.
  it('drops when blocked', () => {
    expect(decideTopicPlanTurn({ ...base, blocked: true })).toBe('drop');
  });

  it('drops when AI access is locked', () => {
    expect(decideTopicPlanTurn({ ...base, aiLocked: true })).toBe('drop');
  });

  it('drops rather than waits even while the gate is still closed', () => {
    // Ordering matters: a blocked user whose cards are also unresolved must not
    // leave a nonce parked behind the gate.
    expect(decideTopicPlanTurn({ ...base, blocked: true, unresolvedCount: 2 })).toBe('drop');
  });

  // THE SEQUENCER. TopicPlanSaveAllRow loops `await discardTopicPlan(id)`, so
  // every iteration bumps the nonce — but the gate stays non-zero until the
  // last one resolves. Exactly one turn, carrying all N notes.
  it('turns a 3-card "Discard all" into exactly ONE turn', () => {
    let lastFired: number | null = null;
    let fires = 0;
    // Three discards land in sequence; the unresolved count falls 2 → 1 → 0.
    const sequence = [
      { request: 201, unresolvedCount: 2 },
      { request: 202, unresolvedCount: 1 },
      { request: 203, unresolvedCount: 0 },
    ];
    for (const step of sequence) {
      const decision = decideTopicPlanTurn({ ...base, ...step, lastFired });
      if (decision === 'fire') {
        fires += 1;
        lastFired = step.request;
      }
    }
    expect(fires).toBe(1);
    expect(lastFired).toBe(203);
  });

  // A stale nonce surviving "New chat" is the hazard the store clears; if it
  // ever reached here, firing it would be wrong.
  it('does not re-fire a nonce it has already fired, however long it sits', () => {
    expect(decideTopicPlanTurn({ ...base, request: 500, lastFired: 500 })).toBe('wait');
    expect(
      decideTopicPlanTurn({ ...base, request: 500, lastFired: 500, unresolvedCount: 0 }),
    ).toBe('wait');
  });
});
