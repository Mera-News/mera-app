// Location-caught rows (fbx P4): the scorer's location screen catches a foreign-place story before
// any model reads it. The cloud lane must save it at relevance 0 (complete, no note, not excluded) and
// never submit it; a domestic sibling in the same batch is still scored. The catch itself is faked at
// computeMathStage (the real screen belongs to the scoring engine's own tests).

import * as pipeline from '@/lib/services/scoring-pipeline';
import {
  batches,
  cleanupWorld,
  drive,
  gateway,
  holdJobs,
  jobSubmits,
  later,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  warmAttestation,
} from './scoring-pipeline-kit';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.mock('@/lib/mera-protocol/stage-scoring', () => {
  const actual = jest.requireActual('@/lib/mera-protocol/stage-scoring');
  return {
    ...actual,
    computeMathStage: async (...args: unknown[]) => {
      const math = await actual.computeMathStage(...args);
      const caught = new Set<string>(['caught']);
      const componentsMap = new Map(math.componentsMap);
      componentsMap.set('caught', { locationCaught: true });
      return {
        ...math,
        componentsMap,
        stage: math.stage.filter((c: { input: { id: string } }) => !caught.has(c.input.id)),
        locationCaughtIds: caught,
      };
    },
  };
});

beforeEach(() => resetPipelineWorld());
afterEach(() => cleanupWorld());

it('saves a caught row at relevance 0, complete, submits only the sibling', async () => {
  const script = { scores: { sib: 0.9 } };
  gateway(script, { pendingPolls: 999 });
  await warmAttestation();
  await seedAndEnqueue(['caught', 'sib'], { flush: true });
  const batch = (await batches())[0];
  gateway(script);
  holdJobs((id) => id !== batch.requestId);
  later();
  await drive(pipeline.handlePush(batch.requestId, 'foreground'));

  const r = await rows();
  expect(r.caught).toMatchObject({ relevance: 0, reason: '', status: 'complete' });
  expect(r.caught.status).not.toBe('excluded');
  expect(r.caught.rawScore).toBe(0);
  expect(r.sib.relevance).toBeGreaterThan(0);
  const submitted = jobSubmits().flatMap((s) => s.calls);
  expect(submitted).toContain('score:0');
  // one scored article only: the caught row never reached a relevance call
  expect(jobSubmits()[0].calls).toEqual(['score:0']);
});
