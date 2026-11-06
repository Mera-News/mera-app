// A parent that re-renders on completion hands PinSetupScreen a new onComplete; the save must still run once.
import React, { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import * as pinService from '@/lib/security/pin-service';

const enter = async (r: Awaited<ReturnType<typeof render>>, digits: string) => {
  for (const d of digits) await fireEvent.press(r.getByText(d));
};

const Parent = ({ onDone }: { onDone: () => void }) => {
  const [, setBusy] = useState(false);
  return (
    <PinSetupScreen
      onComplete={async () => {
        setBusy(true);
        onDone();
        await new Promise((r) => setTimeout(r, 5));
        setBusy(false);
      }}
    />
  );
};

describe('PinSetupScreen', () => {
  it('persists once when the parent re-renders on completion', async () => {
    const save = jest.spyOn(pinService, 'setPin');
    const onDone = jest.fn();
    const r = await render(<Parent onDone={onDone} />);
    await enter(r, '1234');
    await enter(r, '1234');
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
