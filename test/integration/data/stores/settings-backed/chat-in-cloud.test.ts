// Cloud chat while On this phone (`chatInCloud`) against the real settings table: the setter
// writes its row, a hydrate reads it back (absent is off), reset deletes it, and
// chatRunsInCloud() only counts it in OnDevice.
import { getSetting } from '@/lib/database/services/setting-service';
import { isBackedUpSettingKey } from '@/lib/backup/allowlist';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { chatRunsInCloud } from '@/lib/llm/chat-cloud';
import { SETTING_CHAT_IN_CLOUD, useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { persisted, resetStore, until } from './support';

const protocol = () => useMeraProtocolStore.getState();

beforeEach(() => resetStore(useMeraProtocolStore));

it('persists under its own row, which backup carries, and a stored on survives a hydrate', async () => {
  protocol().setChatInCloud(true);
  expect(await persisted(SETTING_CHAT_IN_CLOUD, 'true')).toBe('true');
  expect(isBackedUpSettingKey(SETTING_CHAT_IN_CLOUD)).toBe(true);

  resetStore(useMeraProtocolStore);
  await protocol().hydrateFromDb();
  expect(protocol().chatInCloud).toBe(true);

  protocol().setChatInCloud(false);
  await persisted(SETTING_CHAT_IN_CLOUD, 'false');
  useMeraProtocolStore.setState({ chatInCloud: true });
  await protocol().hydrateFromDb();
  expect(protocol().chatInCloud).toBe(false);
});

it('an absent row hydrates as off, and reset deletes the row', async () => {
  protocol().setChatInCloud(true);
  await persisted(SETTING_CHAT_IN_CLOUD, 'true');

  protocol().reset();
  expect(protocol().chatInCloud).toBe(false);
  await until(async () => (await getSetting(SETTING_CHAT_IN_CLOUD)) === null, 'row deleted');

  useMeraProtocolStore.setState({ chatInCloud: true });
  await protocol().hydrateFromDb();
  expect(protocol().chatInCloud).toBe(false);
});

it.each([
  [ProcessingMode.Cloud, false, true],
  [ProcessingMode.Cloud, true, true],
  [ProcessingMode.OnDevice, false, false],
  [ProcessingMode.OnDevice, true, true],
])('chat runs in the cloud in %s with cloud chat %s: %s', (processingMode, chatInCloud, expected) => {
  useMeraProtocolStore.setState({ processingMode, chatInCloud });
  expect(chatRunsInCloud()).toBe(expected);
});
