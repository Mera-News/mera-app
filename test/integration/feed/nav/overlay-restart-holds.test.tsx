// The two overlays that cannot be rebuilt after an update reload hold the automatic restart while open.
import { renderHook } from '@testing-library/react-native';

import { __resetAppRestartForTests, activeHolds, useRestartHold } from '@/lib/app-restart';

// ArrangeOverlay and InlineChoiceChip each call exactly this hook with these labels; rendering either
// needs the whole gesture/animation stack, so the contract under test is the hold's lifecycle plus the
// labels the source declares.
import fs from 'fs';
import path from 'path';

const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../../../components/custom/nav', f), 'utf8');

describe('overlay restart holds', () => {
  beforeEach(() => __resetAppRestartForTests());

  it('ArrangeOverlay and InlineChoiceChip declare their holds', () => {
    expect(src('ArrangeOverlay.tsx')).toContain("useRestartHold(true, 'world-arrange', 'auto')");
    expect(src('InlineChoiceChip.tsx')).toContain("useRestartHold(isOpen, 'overlay:sheet', 'auto')");
  });

  it.each([['world-arrange'], ['overlay:sheet']])('%s is held while open, gone after close and unmount', (label) => {
    const h = renderHook(({ open }: { open: boolean }) => useRestartHold(open, label, 'auto'), {
      initialProps: { open: true },
    });
    expect(activeHolds()).toContain(label);
    h.rerender({ open: false });
    expect(activeHolds()).not.toContain(label);
    h.rerender({ open: true });
    h.unmount();
    expect(activeHolds()).not.toContain(label);
  });
});
