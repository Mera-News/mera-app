// Whether deleting a fact's topic asks first: a per-device flag on the stateful AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  setConfirmTopicDelete,
  shouldConfirmTopicDelete,
  SKIP_TOPIC_DELETE_CONFIRM_KEY,
} from '@/components/custom/facts/topic-delete-confirm';

it('asks on a device that stored nothing', async () => {
  expect(await shouldConfirmTopicDelete()).toBe(true);
  expect(await AsyncStorage.getItem(SKIP_TOPIC_DELETE_CONFIRM_KEY)).toBeNull();
});

it("Don't ask again turns it off; the Settings switch turns it back on", async () => {
  await setConfirmTopicDelete(false);
  expect(await AsyncStorage.getItem(SKIP_TOPIC_DELETE_CONFIRM_KEY)).toBe('1');
  expect(await shouldConfirmTopicDelete()).toBe(false);

  await setConfirmTopicDelete(true);
  expect(await AsyncStorage.getItem(SKIP_TOPIC_DELETE_CONFIRM_KEY)).toBeNull();
  expect(await shouldConfirmTopicDelete()).toBe(true);
});

it('a storage that throws reads as "ask", and a failed write leaves the earlier choice', async () => {
  await setConfirmTopicDelete(false);
  const get = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage down'));
  try {
    expect(await shouldConfirmTopicDelete()).toBe(true);
  } finally {
    get.mockRestore();
  }

  const set = jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('storage down'));
  try {
    await expect(setConfirmTopicDelete(true)).resolves.toBeUndefined();
  } finally {
    set.mockRestore();
  }
  expect(await shouldConfirmTopicDelete()).toBe(false);
});
