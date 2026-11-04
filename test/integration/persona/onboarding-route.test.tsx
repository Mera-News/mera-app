// The onboarding route's handleComplete: the one landing after the wizard, and after a re-login to a
// finished device.
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import Onboarding from '@/app/logged-in/onboarding';
import { setSetting } from '@/lib/database/services/setting-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';

let finish: (() => void) | undefined;
jest.mock('@/components/custom/onboarding/OnboardingScreen', () => ({
  __esModule: true,
  default: ({ onComplete }: { onComplete: () => void }) => {
    finish = onComplete;
    return null;
  },
}));

it('lands on World and starts a feed sync past the debounce', async () => {
  const trigger = jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran');
  await setSetting('cached_user_id', 'user-1');
  await render(<Onboarding />);
  await waitFor(() => expect(finish).toBeDefined());

  finish?.();

  expect(router.replace).toHaveBeenCalledWith('/logged-in/app_container/world');
  expect(trigger).toHaveBeenCalledWith('feed-sync', undefined, { bypassDebounce: true });
  trigger.mockRestore();
});
