// Input shapes of the persona_summary and tracked_story_migrate handlers that the legacy suites
// reached and summary-and-story-handlers.test.ts does not: a fact that owns no topic yet, a fact
// that owns several, a topic no fact owns, and a queued payload whose titles are not a list.
// The real handlers run over real rows; the cloud branch goes through the gateway mock.
//
// Not reachable through the seam (R30 / F15): tracked-story-migrate-handler.ts `topic?.id ?? null`,
// because `createTopics` returns one row per input.
import { addFact } from '@/lib/database/services/fact-service';
import { getAllSummaryStrings } from '@/lib/database/services/persona-summary-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { buildPersonaSummaryInputs, handlePersonaSummaryJob } from '@/lib/inference/handlers/persona-summary-handler';
import { handleTrackedStoryMigrateJob } from '@/lib/inference/handlers/tracked-story-migrate-handler';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { installLlama, llamaCalls, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, prepare } from './kit';

// Hoisted above the imports by babel-jest.
jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]);
  await prepare();
});
afterEach(cleanup);

describe('persona_summary inputs', () => {
  it('a fact with no topic yet is listed with an empty topic list and still summarised', async () => {
    const pune = await addFact('Lives in Pune');
    server.use(...mockGateway(() => '[{"text":"Lives in Pune","facts":[1]}]'));

    expect(await buildPersonaSummaryInputs()).toEqual([{ factId: pune.id, statement: 'Lives in Pune', weight: 1, topicIds: [] }]);
    expect(await driveDone(handlePersonaSummaryJob({ useCloud: true, personaVersion: 'v' }))).toEqual({ count: 1 });
    expect((await getAllSummaryStrings()).map((r) => [r.text, r.linkedFactIds, r.linkedTopicIds])).toEqual([
      ['Lives in Pune', [pune.id], []],
    ]);
  });

  it('a fact keeps every topic it owns, and a topic no fact owns joins none', async () => {
    const pune = await addFact('Lives in Pune');
    const [a, b] = await createTopics([
      { factId: pune.id, text: 'Pune news', weight: 1, provenance: 'llm' },
      { factId: pune.id, text: 'Pune weather', weight: 1, provenance: 'llm' },
    ]);
    await createTopics([{ text: 'Orphan topic', weight: 1, provenance: 'llm' }]);

    const [input] = await buildPersonaSummaryInputs();

    expect(input.topicIds.slice().sort()).toEqual([a.id, b.id].sort());
  });
});

describe('tracked_story_migrate payload', () => {
  it('titles that are not a list are treated as none: no model, no writes', async () => {
    const out = await driveDone(
      handleTrackedStoryMigrateJob({ trackedStoryId: 'story-3', titles: 'Floods hit Assam' as unknown as string[], useCloud: true }),
    );

    expect(out).toEqual({ ok: false });
    expect(gatewayCalls()).toHaveLength(0);
    expect(llamaCalls()).toHaveLength(0);
  });
});
