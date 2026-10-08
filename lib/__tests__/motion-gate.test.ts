// Owner rule: Lite = no motion. The gate every animation asks.
import { isMotionAllowed, motionAllowed } from '@/lib/motion-gate';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

test('the rule: motion only when neither Lite nor Reduce Motion is on', () => {
    expect(isMotionAllowed(false, false)).toBe(true);
    expect(isMotionAllowed(true, false)).toBe(false);
    expect(isMotionAllowed(false, true)).toBe(false);
    expect(isMotionAllowed(true, true)).toBe(false);
});

test('the getter follows Lite live', () => {
    useDisplayPrefsStore.setState({ liteMode: true });
    expect(motionAllowed()).toBe(false);
    useDisplayPrefsStore.setState({ liteMode: false });
    expect(motionAllowed()).toBe(true);
});
