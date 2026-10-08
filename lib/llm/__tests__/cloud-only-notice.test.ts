const mockShow = jest.fn(async (_o: unknown) => true);
jest.mock('../../dialog', () => ({ showDialog: (o: unknown) => mockShow(o) }));
const mockOnDevice = jest.fn(async () => false);
jest.mock('../on-device-gate', () => ({ isOnDeviceMode: () => mockOnDevice() }));
jest.mock('../../i18n', () => ({ __esModule: true, default: { t: (k: string) => `T(${k})` } }));

import { blockIfOnDevice, cloudOnlyNoticeText } from '../cloud-only-notice';

beforeEach(() => {
  mockShow.mockClear();
  mockOnDevice.mockResolvedValue(false);
});

it('in cloud mode it lets the action run and shows nothing', async () => {
  expect(await blockIfOnDevice()).toBe(false);
  expect(mockShow).not.toHaveBeenCalled();
});

it('on-device it blocks and shows ONE in-app dialog with the shared key', async () => {
  mockOnDevice.mockResolvedValue(true);
  expect(await blockIfOnDevice()).toBe(true);
  expect(mockShow).toHaveBeenCalledTimes(1);
  expect(mockShow.mock.calls[0][0]).toMatchObject({
    title: 'T(meraProtocol.title)',
    body: 'T(chat.cloudOnlyNotice)',
    confirmLabel: 'T(common.ok)',
  });
  expect(cloudOnlyNoticeText()).toBe('T(chat.cloudOnlyNotice)');
});
