// The integration setup's expo-haptics mock: callable, awaitable, real enum values.
import * as Haptics from 'expo-haptics';

it('expo-haptics resolves and carries the real enum values', async () => {
  await expect(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)).resolves.toBeUndefined();
  await expect(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)).resolves.toBeUndefined();
  expect(Haptics.impactAsync).toHaveBeenCalledWith('medium');
  expect((await import('expo-haptics')).selectionAsync).toBe(Haptics.selectionAsync);
});
