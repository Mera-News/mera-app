// The shared native-edge mocks carry what the real services read, so no suite needs a local copy.
import * as TaskManager from 'expo-task-manager';
import { registerForPushNotificationsAsync } from '@/lib/notification-service';

it('registerForPushNotificationsAsync runs on the shared expo-notifications mock', async () => {
  await expect(registerForPushNotificationsAsync()).resolves.toBe('ExponentPushToken[test-token]');
});

it('expo-task-manager answers getRegisteredTasksAsync with an empty registry', async () => {
  await expect(TaskManager.getRegisteredTasksAsync()).resolves.toEqual([]);
});
