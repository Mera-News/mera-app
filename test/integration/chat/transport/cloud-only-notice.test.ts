// The one in-app notice for a cloud-only action tried on-device. The dialog is asserted through its
// own queue (lib/dialog), the copy through the real English dictionary, and the mode through the
// real mera-protocol store and the persisted row.
import { setSetting } from '@/lib/database/services/setting-service';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { blockIfOnDevice, cloudOnlyNoticeText } from '@/lib/llm/cloud-only-notice';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { initI18nEn } from '@/test/helpers';

const NOTICE = "This needs Mera's private cloud. You can switch in Settings, under Mera Protocol.";

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

it('in cloud mode it lets the action run and shows nothing', async () => {
  expect(await blockIfOnDevice()).toBe(false);
  expect(useDialogQueue.getState().queue).toEqual([]);
});

it('on-device it blocks and shows ONE in-app dialog with the shared copy', async () => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });

  expect(await blockIfOnDevice()).toBe(true);

  const { queue } = useDialogQueue.getState();
  expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({ title: 'Mera Protocol', body: NOTICE, confirmLabel: 'OK' });
  expect(cloudOnlyNoticeText()).toBe(NOTICE);
});

it('blocks on the persisted on-device row while the store is still on its Cloud default', async () => {
  await setSetting('mera_processing_mode', ProcessingMode.OnDevice);

  expect(await blockIfOnDevice()).toBe(true);
  expect(useDialogQueue.getState().queue).toHaveLength(1);
});

it('is a one-button notice: the host settling it clears the queue', async () => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
  await blockIfOnDevice();
  const [request] = useDialogQueue.getState().queue;
  expect(request.cancelLabel).toBeUndefined();

  settleDialog(request.id, false);

  expect(useDialogQueue.getState().queue).toEqual([]);
});
