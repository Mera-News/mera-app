// harness-local — the topic runner's isolated+combo flow (ux2 F6).
//
//   npx tsx --tsconfig harness-local/tsconfig.json --test \
//     harness-local/scripts/run-topicgen-corpus.test.ts
//
// jest ignores harness-local, so this runs on node's own test runner. Read the
// exit code.
//
// WHAT IT PROVES. The measurement is only a measurement if the isolated call
// the runner makes really sees ONE fact. The runner holds the whole persona
// when it builds that call, so leaking another fact into it is one wrong
// argument away. These tests capture the OUTGOING request and look for every
// other fact's statement in it. The combo call is the control: it must carry
// the other facts, or a detector that never fires would pass the first test
// for the wrong reason.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runComboStep,
  runIsolatedStep,
  type FlowCaller,
  type FlowFact,
  type FlowModelRequest,
} from './run-topicgen-corpus';
import { f6Leak, f6NamesSubject, f6Words } from './score-topic-run';

const FACTS: FlowFact[] = [
  {
    id: 'o01',
    statement: 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU',
    questionnaireAttribute: 'location: neighborhood/area, city, and country (preserve specifics)',
    createdAtMs: 1,
  },
  { id: 'o02', statement: 'From India', questionnaireAttribute: 'background: country of origin', createdAtMs: 2 },
  {
    id: 'o03',
    statement: 'Works as a harbour pilot in Rotterdam',
    questionnaireAttribute: 'profession: job',
    createdAtMs: 3,
  },
];

function recordingCaller(output: string): { call: FlowCaller; seen: FlowModelRequest[] } {
  const seen: FlowModelRequest[] = [];
  const call: FlowCaller = async (req) => {
    seen.push(req);
    return {
      content: output,
      toolCalls: [],
      finishReason: 'stop',
      truncated: false,
      usage: null,
      modelSent: 'fake',
      latencyMs: 1,
      error: null,
    };
  };
  return { call, seen };
}

function wholeRequest(req: FlowModelRequest): string {
  return `${req.systemPrompt}\n${req.userMessage}`;
}

test('the isolated call carries its own fact and NO other fact', async () => {
  for (let fi = 0; fi < FACTS.length; fi++) {
    const { call, seen } = recordingCaller('["A topic", "Another topic"]');
    await runIsolatedStep({
      facts: FACTS,
      factIndex: fi,
      existingTopicsByFact: new Map([
        ['o01', ['Amsterdam housing']],
        ['o02', ['India elections']],
        ['o03', ['Port of Rotterdam']],
      ]),
      declinedTopics: [],
      call,
    });
    assert.equal(seen.length, 1, `fact ${fi}: exactly one isolated request`);
    const text = wholeRequest(seen[0]);
    assert.ok(seen[0].userMessage.includes(FACTS[fi].statement), `fact ${fi}: its own statement is sent`);
    for (let other = 0; other < FACTS.length; other++) {
      if (other === fi) continue;
      assert.ok(
        !text.includes(FACTS[other].statement),
        `fact ${fi}: the isolated request carries fact ${other} ("${FACTS[other].statement}")`,
      );
    }
    assert.ok(!/Other user facts/i.test(seen[0].userMessage), `fact ${fi}: no other-facts line`);
    assert.ok(!/User location/i.test(seen[0].userMessage), `fact ${fi}: no location line`);
    // THIS fact's topics are the exclusions; another fact's are not.
    const otherTopics = ['Amsterdam housing', 'India elections', 'Port of Rotterdam'].filter((_, i) => i !== fi);
    for (const t of otherTopics) {
      assert.ok(!seen[0].userMessage.includes(t), `fact ${fi}: another fact's topic "${t}" is excluded`);
    }
  }
});

test('the isolated call routes the skill off the attribute', async () => {
  const { call, seen } = recordingCaller('[]');
  const rec = await runIsolatedStep({
    facts: FACTS, factIndex: 0, existingTopicsByFact: new Map(), declinedTopics: [], call,
  });
  assert.equal(rec.skillId, 'topics/residence');
  assert.equal(rec.stage, 'isolated');
  assert.equal(seen[0].enableThinking, false);
});

test('CONTROL: the combo call does carry the other facts, newest first', async () => {
  const { call, seen } = recordingCaller('["Rotterdam port India trade"]');
  const seenTexts = new Set<string>();
  const rec = await runComboStep({ facts: FACTS, factIndex: 0, seen: seenTexts, call });
  assert.ok(rec, 'a combo record');
  assert.equal(seen.length, 1);
  const msg = seen[0].userMessage;
  assert.ok(msg.includes(FACTS[1].statement) && msg.includes(FACTS[2].statement), 'other facts are present');
  assert.ok(msg.indexOf(FACTS[2].statement) < msg.indexOf(FACTS[1].statement), 'newest first');
  assert.equal(seen[0].temperature, 0.3);
  assert.equal(seen[0].maxTokens, 400);
  assert.equal(seen[0].enableThinking, false);
  assert.equal(rec!.stage, 'combo');
  assert.deepEqual(rec!.topics, ['Rotterdam port India trade']);
});

test('the combo stage drops what is already on the device or declined', async () => {
  const { call } = recordingCaller('["India elections", "Amsterdam Indian community", "brand new topic"]');
  const seenTexts = new Set(['india elections', 'brand new topic']);
  const rec = await runComboStep({ facts: FACTS, factIndex: 0, seen: seenTexts, call });
  assert.deepEqual(rec!.topics, ['Amsterdam Indian community']);
  assert.ok(seenTexts.has('amsterdam indian community'), 'an accepted text joins the seen set');
});

// ---- the scorer's pre-registered definitions (score-topic-run.ts --flow) ----

test('a word the topic shares with its OWN fact is not a leak; the literal reading still counts it', () => {
  const home = 'Lives in Nieuw-West, Amsterdam, North Holland, The Netherlands, EU';
  const own = f6Leak('Netherlands expat housing', 'Expat in The Netherlands', [home, 'From India']);
  assert.deepEqual(own.primary, []);
  assert.deepEqual(own.literal, ['netherland']);
  const leak = f6Leak('Amsterdam Indian community events', home, ['From India', 'Expat in The Netherlands']);
  assert.deepEqual(leak.primary, [], 'Indian is not India: no stemming beyond a plural s');
  const real = f6Leak('Amsterdam India consulate', home, ['From India']);
  assert.deepEqual(real.primary, ['india']);
  assert.deepEqual(f6Leak('Rotterdam port news', 'Lives in Rotterdam', ['Works in Rotterdam port']).primary, ['port']);
});

test('statement-frame words never count as content', () => {
  assert.deepEqual([...f6Words('Lives in Rotterdam since 2019, especially the harbour')], ['rotterdam', '2019', 'harbour']);
});

test('the subject proxy matches a shared word or a 5-letter prefix, and misses a paraphrase', () => {
  assert.equal(f6NamesSubject('Indian diaspora voting rules', 'From India'), true);
  assert.equal(f6NamesSubject('Portuguese ferry strikes', 'Visits Portugal and Madeira'), true);
  assert.equal(f6NamesSubject('Rotterdam marathon', 'Runs three times a week'), false);
});
