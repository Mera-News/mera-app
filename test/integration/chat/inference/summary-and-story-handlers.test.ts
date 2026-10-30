// The three small job handlers: persona_summary, story_headline, tracked_story_migrate. Each runs
// the real handler over real rows; the cloud branch goes through the gateway mock, the on-device
// branch through the scripted llama.rn, and a queued job keeps the `useCloud` it was enqueued with,
// so every handler re-asks the on-device gate (a cloud-queued job runs LOCALLY once the mode flips).
//
// Replaces (all `it`):
//   handlers/__tests__/on-device-stale-payload.test.ts (1)
//   handlers/__tests__/persona-summary-handler.test.ts (7): inputs join; cloud; on-device; empty
//     persona; malformed output; transport failure; valid JSON with nothing usable
//   handlers/__tests__/story-headline-handler.test.ts (7): dedupe key; cloud; on-device; no titles;
//     no story id; transport failure; parse failure
//   handlers/__tests__/tracked-story-migrate-handler.test.ts (8): dedupe key; cloud; null topic id
//     when the mint returns nothing (UNREACHABLE through the seam, see below); on-device; empty
//     titles; missing story id; transport failure; parse failure
//
// The "binds a null topic id when the mint returns nothing" case is not rebuilt: `createTopics` is
// resolve-or-create and returns one row per input, so `topic?.id ?? null` cannot be reached with a
// parseable scope (a blank `search` makes the parser fall back to `label`, and a model output with
// neither throws before the mint). Reported for the fence ledger.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type InferenceJob from '@/lib/database/models/InferenceJob';
import { addFact } from '@/lib/database/services/fact-service';
import { getAllSummaryStrings, replaceAllSummaryStrings } from '@/lib/database/services/persona-summary-service';
import { createTopics, getAllByNormalizedText } from '@/lib/database/services/topic-service';
import { getTrackedStoryById, trackStory } from '@/lib/database/services/tracked-story-service';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { buildPersonaSummaryInputs, handlePersonaSummaryJob } from '@/lib/inference/handlers/persona-summary-handler';
import { handleStoryHeadlineJob, storyHeadlineDedupeKey } from '@/lib/inference/handlers/story-headline-handler';
import { handleTrackedStoryMigrateJob, trackedStoryMigrateDedupeKey } from '@/lib/inference/handlers/tracked-story-migrate-handler';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { STORY_SCOPE_SYSTEM } from '@/lib/news-harness/on-device/story-scope/prompt';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { installLlama, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, prepare, tick, untilJob, watchBodies, setMode } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]); // Kev on disk; the text runs on the built-in model
  installOnDeviceLlm(); // a clean call log: onDeviceLlmCalls() counts this test's calls only
  await prepare();
});
afterEach(cleanup);

const reply = (text: string) => server.use(...mockGateway(() => text));
const refuse = () => server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));
const noGateway = () => expect(gatewayCalls()).toHaveLength(0);

// ---- persona_summary --------------------------------------------------------------------------

async function seedPersona() {
  const pune = await addFact('Lives in Pune');
  await tick(5);
  const ai = await addFact('Works in AI');
  const [t1] = await createTopics([{ factId: pune.id, text: 'Pune news', weight: 1, provenance: 'llm' }]);
  const [t2] = await createTopics([{ factId: ai.id, text: 'AI news', weight: 1, provenance: 'llm' }]);
  return { pune, ai, t1, t2 };
}

describe('persona_summary', () => {
  const OLD = { text: 'Old line', linkedFactIds: [], linkedTopicIds: [] };

  it('joins every fact with its weight and the ids of the topics it owns, newest fact first', async () => {
    const { pune, ai, t1, t2 } = await seedPersona();
    expect(await buildPersonaSummaryInputs()).toEqual([
      { factId: ai.id, statement: 'Works in AI', weight: 1, topicIds: [t2.id] },
      { factId: pune.id, statement: 'Lives in Pune', weight: 1, topicIds: [t1.id] },
    ]);
  });

  it('cloud: one 512-token call, and the assembled strings are stored with their linked facts and topics', async () => {
    const { pune, ai, t1, t2 } = await seedPersona();
    // The model cites the 1-based list it was shown: 1 is the newest fact.
    reply('[{"text":"Works in AI","facts":[1]},{"text":"Lives in Pune","facts":[2]}]');
    const bodies = watchBodies('/v1/chat/completions');

    const out = await driveDone(handlePersonaSummaryJob({ useCloud: true, personaVersion: 'v1:2:x' }));

    expect(out).toEqual({ count: 2 });
    expect(gatewayCalls('chat')).toHaveLength(1);
    expect(gatewayCalls('chat')[0].messages[1].content).toContain('1. Works in AI');
    expect((await bodies.bodies())[0]).toMatchObject({ max_tokens: 512, temperature: 0.4 });
    const rows = await getAllSummaryStrings();
    expect(rows.map((r) => [r.text, r.linkedFactIds, r.linkedTopicIds, r.personaVersion])).toEqual([
      ['Works in AI', [ai.id], [t2.id], 'v1:2:x'],
      ['Lives in Pune', [pune.id], [t1.id], 'v1:2:x'],
    ]);
    expect(onDeviceLlmCalls()).toHaveLength(0);
  });

  it('on-device: the local engine writes the strings and the gateway hears nothing', async () => {
    await seedPersona();
    await setMode('on-device');
    await setMode('on-device');
    installOnDeviceLlm({ reply: '[{"text":"Works in AI","facts":[1]}]' });

    const out = await driveDone(handlePersonaSummaryJob({ useCloud: false, personaVersion: 'v' }));

    expect(out).toEqual({ count: 1 });
    expect(onDeviceLlmCalls()).toHaveLength(1);
    noGateway();
    expect((await getAllSummaryStrings()).map((r) => r.text)).toEqual(['Works in AI']);
  });

  it('a payload queued for the cloud runs locally once the mode is on-device (never the cloud AI)', async () => {
    await seedPersona();
    await setMode('on-device');
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"strings":[]}' });

    await driveDone(handlePersonaSummaryJob({ useCloud: true }));

    expect(onDeviceLlmCalls()).toHaveLength(1);
    noGateway();
  });

  it('an empty persona clears the stored strings and asks no model', async () => {
    await replaceAllSummaryStrings([OLD], 'v0');

    const out = await driveDone(handlePersonaSummaryJob({ useCloud: true, personaVersion: 'v' }));

    expect(out).toEqual({ count: 0 });
    expect(await getAllSummaryStrings()).toEqual([]);
    noGateway();
  });

  describe('leaves the previous strings alone', () => {
    beforeEach(async () => {
      await seedPersona();
      await replaceAllSummaryStrings([OLD], 'v0');
    });
    const kept = async () => (await getAllSummaryStrings()).map((r) => [r.text, r.personaVersion]);

    it('on malformed model output', async () => {
      reply('sorry, I cannot help with that');
      expect(await driveDone(handlePersonaSummaryJob({ useCloud: true }))).toEqual({ count: 0 });
      expect(await kept()).toEqual([['Old line', 'v0']]);
    });

    it('on a transport failure', async () => {
      refuse();
      expect(await driveDone(handlePersonaSummaryJob({ useCloud: true }))).toEqual({ count: 0 });
      expect(await kept()).toEqual([['Old line', 'v0']]);
    });

    it('on valid JSON with no usable string', async () => {
      reply('[]');
      expect(await driveDone(handlePersonaSummaryJob({ useCloud: true }))).toEqual({ count: 0 });
      expect(await kept()).toEqual([['Old line', 'v0']]);
    });
  });

  it('through the queue the job row carries the count', async () => {
    await seedPersona();
    reply('[{"text":"Works in AI","facts":[1]},{"text":"Lives in Pune","facts":[2]}]');
    const id = await enqueueJob('persona_summary', { useCloud: true, personaVersion: 'v1' });

    await inferenceQueue.start();
    const row = await untilJob(id, ['done']);

    expect(row?.result).toEqual({ count: 2 });
  });
});

// ---- story_headline ----------------------------------------------------------------------------

const TITLES = ['Floods hit Assam', 'Assam floods displace thousands'];
const legacyStory = () => trackStory({ articleId: 'a1', title: 'Floods hit Assam', originSurface: 'feed' });

describe('story_headline', () => {
  it('has a dedupe key namespaced by the story id', () => {
    expect(storyHeadlineDedupeKey('story-9')).toBe('story_headline:story-9');
  });

  it('cloud: one 128-token call writes the headline onto the story', async () => {
    const story = await legacyStory();
    reply('{"headline":"Assam floods displace thousands"}');
    const bodies = watchBodies('/v1/chat/completions');

    const out = await driveDone(handleStoryHeadlineJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: true });
    expect((await bodies.bodies())[0]).toMatchObject({ max_tokens: 128, temperature: 0.3 });
    expect(gatewayCalls('chat')[0].messages[1].content).toContain('Floods hit Assam');
    expect((await getTrackedStoryById(story.id))?.llmHeadline).toBe('Assam floods displace thousands');
  });

  it('on-device (the default when useCloud is absent): the local engine writes it, zero gateway calls', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"headline":"Assam floods"}' });

    const out = await driveDone(handleStoryHeadlineJob({ trackedStoryId: story.id, titles: TITLES }));

    expect(out).toEqual({ ok: true });
    expect(onDeviceLlmCalls()).toHaveLength(1);
    noGateway();
    expect((await getTrackedStoryById(story.id))?.llmHeadline).toBe('Assam floods');
  });

  it('a cloud-queued payload runs locally once the mode is on-device', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"headline":"Assam floods"}' });

    await driveDone(handleStoryHeadlineJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(onDeviceLlmCalls()).toHaveLength(1);
    noGateway();
  });

  it.each([
    ['no titles', { trackedStoryId: 'story-3', titles: [] as string[] }],
    ['no story id', { trackedStoryId: '', titles: TITLES }],
  ])('an invalid payload (%s) asks no model and writes nothing', async (_label, payload) => {
    expect(await driveDone(handleStoryHeadlineJob({ ...payload, useCloud: true }))).toEqual({ ok: false });
    noGateway();
    expect(onDeviceLlmCalls()).toHaveLength(0);
  });

  it('a transport failure keeps the fallback title', async () => {
    const story = await legacyStory();
    refuse();

    const out = await driveDone(handleStoryHeadlineJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: false });
    expect((await getTrackedStoryById(story.id))?.llmHeadline ?? null).toBeNull();
  });

  it('garbage output keeps the fallback title', async () => {
    const story = await legacyStory();
    reply('sorry, I cannot help with that');

    const out = await driveDone(handleStoryHeadlineJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: false });
    expect((await getTrackedStoryById(story.id))?.llmHeadline ?? null).toBeNull();
  });

  it('through the queue the job row carries ok', async () => {
    const story = await legacyStory();
    reply('{"headline":"Assam floods"}');
    const id = await enqueueJob('story_headline', { trackedStoryId: story.id, titles: TITLES, useCloud: true });

    await inferenceQueue.start();

    expect((await untilJob(id, ['done']))?.result).toEqual({ ok: true });
  });
});

// ---- tracked_story_migrate ---------------------------------------------------------------------

const SCOPE_JSON = '{"label":"Assam floods","search":"assam floods displacement"}';

describe('tracked_story_migrate', () => {
  const unmigrated = async (story: { id: string }) => {
    const row = await getTrackedStoryById(story.id);
    return { topicId: row?.topicId ?? null, topicText: row?.topicText ?? null, headline: row?.llmHeadline ?? null };
  };

  it('has a dedupe key namespaced by the story id', () => {
    expect(trackedStoryMigrateDedupeKey('story-9')).toBe('tracked_story_migrate:story-9');
  });

  it('cloud: mints a tracked topic from the search, binds it onto the story and sets the label as its headline', async () => {
    const story = await legacyStory();
    reply(SCOPE_JSON);
    const bodies = watchBodies('/v1/chat/completions');

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: true });
    expect((await bodies.bodies())[0]).toMatchObject({ max_tokens: 128, temperature: 0.3 });
    const [topic] = await getAllByNormalizedText('assam floods displacement');
    expect(topic).toMatchObject({ status: 'active', provenance: 'tracked', highPriority: true, weight: 0.85 });
    expect(await unmigrated(story)).toEqual({
      topicId: topic.id,
      topicText: 'assam floods displacement',
      headline: 'Assam floods',
    });
  });

  it('a migrated story asks for its names: one story_names job on the minted topic', async () => {
    const story = await legacyStory();
    reply(SCOPE_JSON);

    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    const [topic] = await getAllByNormalizedText('assam floods displacement');
    const jobs = await database.get<InferenceJob>('inference_jobs').query(Q.where('job_type', 'story_names')).fetch();
    expect(jobs.map((j) => j.payload)).toEqual([
      { topicId: topic.id, label: 'Assam floods', search: 'assam floods displacement', useCloud: true },
    ]);
  });

  it('a second story with the same scope binds the topic that already exists instead of minting a twin', async () => {
    const first = await legacyStory();
    const second = await trackStory({ articleId: 'a2', title: 'Assam floods continue', originSurface: 'feed' });
    reply(SCOPE_JSON);

    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: first.id, titles: TITLES, useCloud: true }));
    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: second.id, titles: TITLES, useCloud: true }));

    const topics = await getAllByNormalizedText('assam floods displacement');
    expect(topics).toHaveLength(1);
    expect((await unmigrated(second)).topicId).toBe(topics[0].id);
  });

  it('on-device: the local engine performs the same writes, zero gateway calls', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: SCOPE_JSON });

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES }));

    expect(out).toEqual({ ok: true });
    noGateway();
    expect((await unmigrated(story)).headline).toBe('Assam floods');
    expect((await getAllByNormalizedText('assam floods displacement')).length).toBe(1);
  });

  it('on-device: its own prompt and the {label, search} schema, never the cloud prompt', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: SCOPE_JSON });

    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES }));

    const [call] = onDeviceLlmCalls();
    expect(call.instructions).toBe(STORY_SCOPE_SYSTEM);
    expect(call.prompt).toContain(`1. ${TITLES[0]}`);
    expect(call).toMatchObject({ kind: 'structured', options: { maxTokens: 128, temperature: 0.3 } });
    expect(JSON.parse(call.schemaJson ?? '')).toMatchObject({ required: ['label', 'search'] });
  });

  it('on-device: output that never fits the schema is retried once, then the story stays legacy', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: 'sorry, I cannot help with that' });

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES }));

    expect(out).toEqual({ ok: false });
    expect(onDeviceLlmCalls()).toHaveLength(2);
    expect(await unmigrated(story)).toEqual({ topicId: null, topicText: null, headline: null });
  });

  it('on-device: a blank field falls back to the other; both blank leaves the story legacy', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"label":"  ","search":"Assam floods"}' });
    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES }));
    expect((await unmigrated(story)).headline).toBe('Assam floods');

    const other = await trackStory({ articleId: 'a3', title: 'Assam floods again', originSurface: 'feed' });
    await setMode('on-device');
    installOnDeviceLlm({ reply: '{"label":"","search":" "}' });
    expect(await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: other.id, titles: TITLES }))).toEqual({ ok: false });
    expect((await unmigrated(other)).headline).toBeNull();
  });

  it('a cloud-queued payload runs locally once the mode is on-device', async () => {
    const story = await legacyStory();
    await setMode('on-device');
    await setMode('on-device');
    installOnDeviceLlm({ reply: SCOPE_JSON });

    await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(onDeviceLlmCalls()).toHaveLength(1);
    noGateway();
  });

  it.each([
    ['empty titles', { trackedStoryId: 'story-3', titles: [] as string[] }],
    ['a missing story id', { trackedStoryId: '', titles: TITLES }],
  ])('%s: no model, no writes', async (_label, payload) => {
    expect(await driveDone(handleTrackedStoryMigrateJob({ ...payload, useCloud: true }))).toEqual({ ok: false });
    noGateway();
    expect(await getAllByNormalizedText('assam floods displacement')).toEqual([]);
  });

  it('a transport failure leaves the story legacy and mints nothing', async () => {
    const story = await legacyStory();
    refuse();

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: false });
    expect(await unmigrated(story)).toEqual({ topicId: null, topicText: null, headline: null });
    expect(await getAllByNormalizedText('assam floods displacement')).toEqual([]);
  });

  it('garbage output leaves the story legacy and mints nothing', async () => {
    const story = await legacyStory();
    reply('sorry, I cannot help with that');

    const out = await driveDone(handleTrackedStoryMigrateJob({ trackedStoryId: story.id, titles: TITLES, useCloud: true }));

    expect(out).toEqual({ ok: false });
    expect(await unmigrated(story)).toEqual({ topicId: null, topicText: null, headline: null });
    expect(await getAllByNormalizedText('assam floods displacement')).toEqual([]);
  });

  it('through the queue the job row carries ok', async () => {
    const story = await legacyStory();
    reply(SCOPE_JSON);
    const id = await enqueueJob('tracked_story_migrate', { trackedStoryId: story.id, titles: TITLES, useCloud: true });

    await inferenceQueue.start();

    expect((await untilJob(id, ['done']))?.result).toEqual({ ok: true });
  });
});
