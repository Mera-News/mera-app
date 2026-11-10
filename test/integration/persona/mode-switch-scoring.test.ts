// The async scoring pipeline enqueues nothing new once the reader switches to On this phone
// (isOnDeviceProcessing guard), and enqueues again after the switch back to Cloud.
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls } from '@/test/helpers';
import {
  cleanupWorld,
  currentRun,
  drive,
  gateway,
  ids,
  passTime,
  resetPipelineWorld,
  seedArticles,
  warmAttestation,
} from './scoring-pipeline-kit';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(), warn: jest.fn(), info: jest.fn(),
    captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn(),
  },
}));

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

it('Cloud -> On this phone stops new runs; On this phone -> Cloud starts them again', async () => {
  const batch = ids(pipeline.MAX_BATCH_ARTICLES);
  await seedArticles(batch);

  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice, chatInCloud: true });
  expect(await drive(pipeline.enqueueCandidates(batch))).toEqual({ deferred: [] });
  expect(await currentRun()).toBeNull();
  expect(gatewayCalls('job')).toHaveLength(0);

  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, chatInCloud: false });
  gateway({}, { pendingPolls: 99 });
  await warmAttestation();
  await drive(pipeline.enqueueCandidates(batch));
  expect(await currentRun()).not.toBeNull();
  await passTime(100);
  expect(gatewayCalls('job').length).toBeGreaterThan(0);
});
