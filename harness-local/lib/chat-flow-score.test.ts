// node:test: npx tsx --test harness-local/lib/chat-flow-score.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeTurn, type TurnOutcome } from './chat-flow-score';

const today = '2026-10-14';
const out = (o: Partial<TurnOutcome>): TurnOutcome => ({
  route: 'kev', calls: [], reply: 'ok', intent: null, fallbackReply: false, tapOnly: false, ...o,
});
const ask = (options: string[]) => ({ name: 'ask_choice', input: { question: 'q', options } });

test('a delete passes on the exact ids; the ask chips are not actions', () => {
  const expect = { calls: ['deleteUserFacts'], deleteIds: ['f3'], intent: 'remove_fact', ask: 'no' as const };
  const v = judgeTurn({ flow: 'persona', expect, today, outcome: out({ intent: 'remove_fact', calls: [{ name: 'deleteUserFacts', input: { fact_ids: ['f3'] } }] }) });
  assert.equal(v.pass, true);
  assert.equal(v.intentOk, true);
  const wrong = judgeTurn({ flow: 'persona', expect, today, outcome: out({ calls: [{ name: 'deleteUserFacts', input: { fact_ids: ['f3', 'f4'] } }] }) });
  assert.equal(wrong.pass, false);
});

test('asking passes only when required or allowed, nothing is staged, and the chips name the mentions', () => {
  const expect = { calls: [], ask: 'required' as const, askMentions: ['Raptors|Toronto'] };
  assert.equal(judgeTurn({ flow: 'persona', expect, today, outcome: out({ calls: [ask(['Follows the Toronto Raptors', 'F1'])] }) }).pass, true);
  assert.equal(judgeTurn({ flow: 'persona', expect, today, outcome: out({ calls: [ask(['A', 'B'])] }) }).why, 'chips miss Raptors|Toronto');
  assert.equal(judgeTurn({ flow: 'persona', expect, today, outcome: out({}) }).why, 'did not ask');
  assert.equal(judgeTurn({ flow: 'persona', expect: { ask: 'no' }, today, outcome: out({ calls: [ask(['A', 'B'])] }) }).pass, false);
});

test('saves go through the fact filter; a correction is replaces or a save beside a staged delete', () => {
  const save = (statement: string, extra = {}) => ({ name: 'saveExtractedFacts', input: { extracted_user_information: [{ statement, ...extra }] } });
  const expect = { toolCalled: 'saveExtractedFacts', saveMentions: ['Vancouver'], replaceIds: ['f1'] };
  assert.equal(judgeTurn({ flow: 'persona', expect, today, outcome: out({ calls: [save('Lives in Vancouver', { replaces: 'f1' })], known: ['Lives in Toronto'] }) }).pass, true);
  const single = out({ route: 'single', calls: [save('Lives in Vancouver'), { name: 'deleteUserFacts', input: { fact_ids: ['f1'] } }], known: ['Lives in Toronto'] });
  const v = judgeTurn({ flow: 'persona', expect: { ...expect, intent: 'correct_fact' }, today, outcome: single });
  assert.equal(v.pass, true);
  assert.equal(v.routeIntent, 'correct_fact');
  const restated = judgeTurn({ flow: 'persona', expect: { toolNotCalled: 'saveExtractedFacts' }, today, outcome: out({ calls: [save('Lives in Toronto')], known: ['Lives in Toronto'] }) });
  assert.equal(restated.pass, true);
});

test('a typed yes on a choose-one card applies nothing; a fixed fallback never passes an answer', () => {
  const apply = { name: 'applyProposal', input: {} };
  assert.equal(judgeTurn({ flow: 'follow', expect: { kind: 'answer' }, today, outcome: out({ calls: [apply], tapOnly: true }) }).pass, true);
  assert.equal(judgeTurn({ flow: 'follow', expect: { kind: 'answer' }, today, outcome: out({ calls: [apply] }) }).pass, false);
  assert.equal(judgeTurn({ flow: 'article', expect: { kind: 'answer' }, today, outcome: out({ fallbackReply: true }) }).why, 'fixed fallback reply');
});

test('a change must name the target topic in the right direction', () => {
  const change = (topicText: string, delta: number) => ({ name: 'proposeChanges', input: { actions: [{ type: 'set_topic_weight', topicText, delta }] } });
  const expect = { kind: 'proposeChanges' as const, intent: 'see_less', target: 'Energy drinks' };
  const ok = judgeTurn({ flow: 'article', expect, today, outcome: out({ intent: 'see_less', calls: [change('Energy drinks', -0.3)] }) });
  assert.deepEqual([ok.pass, ok.targetOk, ok.intentOk], [true, true, true]);
  const first = judgeTurn({ flow: 'article', expect, today, outcome: out({ route: 'single', intent: 'less', calls: [change('Formula 1', -0.3)] }) });
  assert.deepEqual([first.pass, first.targetOk, first.intentOk], [false, false, true]);
});

test('follow_this_story and follow_a_named_story are one act; single follow intent is read off its actions', () => {
  const track = { name: 'proposeTrack', input: { options: [{ label: 'Assam Floods', search: 'assam floods' }, { label: 'Assam Flood Relief', search: 'assam flood relief' }, { label: 'India Monsoon', search: 'india monsoon' }] } };
  const expect = { kind: 'proposeTrack' as const, intent: 'follow_a_named_story' };
  const kev = judgeTurn({ flow: 'follow', expect, today, optionSource: 'floods in assam', outcome: out({ intent: 'follow_this_story', calls: [track] }) });
  assert.deepEqual([kev.pass, kev.intentOk], [true, true]);
  assert.deepEqual(kev.optionFails, []);
  const single = judgeTurn({ flow: 'follow', expect, today, optionSource: 'floods in assam', outcome: out({ route: 'single', calls: [track] }) });
  assert.equal(single.intentOk, true);
});
