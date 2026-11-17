
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { blockIfOnDevice } from '@/lib/llm/cloud-only-notice';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { initI18nEn } from '@/test/helpers';

beforeEach(async () => {
  __resetOnDeviceGateForTests();
  useDialogQueue.setState({ queue: [] });
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  await initI18nEn();
});

afterEach(() => {
  useDialogQueue.setState({ queue: [] });
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});

it('is a one-button notice: the host settling it clears the queue', async () => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
  await blockIfOnDevice();
  const [request] = useDialogQueue.getState().queue;
  expect(request.cancelLabel).toBeUndefined();

  settleDialog(request.id, false);

  expect(useDialogQueue.getState().queue).toEqual([]);
});
