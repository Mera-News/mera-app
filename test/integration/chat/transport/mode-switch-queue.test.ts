// The inference queue re-reads the mode per job: a job queued in Cloud runs on the phone's engine
// once the reader switches to On this phone, and runs in the cloud again after the switch back.
import { addFact } from '@/lib/database/services/fact-service';
import { handlePersonaSummaryJob } from '@/lib/inference/handlers/persona-summary-handler';
import { disposeModel } from '@/lib/mera-protocol-toolkit';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { installOnDeviceLlm, onDeviceLlmCalls } from '@/test/helpers/on-device-llm';
import { installLlama, resetFileSystem } from '@/test/integration/chat/_helpers';
import { cleanup, driveDone, prepare, setMode } from '../inference/kit';

jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);

beforeEach(async () => {
  resetFileSystem();
  await disposeModel();
  useMeraProtocolStore.getState().setModelState('downloaded');
  installLlama([]);
  installOnDeviceLlm({ reply: '{"strings":[]}' });
  server.use(...mockGateway(() => '{"strings":[]}'));
  await prepare();
  await addFact('Lives in Pune');
});
afterEach(cleanup);

it('the next job follows the mode: cloud, then the phone, then cloud again', async () => {
  await driveDone(handlePersonaSummaryJob({ useCloud: true }));
  expect(gatewayCalls('chat')).toHaveLength(1);
  expect(onDeviceLlmCalls()).toHaveLength(0);

  await setMode('on-device');
  await setMode('on-device');
  await driveDone(handlePersonaSummaryJob({ useCloud: true }));
  expect(gatewayCalls('chat')).toHaveLength(1); // no new cloud call
  expect(onDeviceLlmCalls()).toHaveLength(1);

  await setMode('cloud');
  await driveDone(handlePersonaSummaryJob({ useCloud: true }));
  expect(gatewayCalls('chat')).toHaveLength(2);
  expect(onDeviceLlmCalls()).toHaveLength(1);
});
