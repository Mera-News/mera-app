// Owner rule: Lite = no motion. The gate every animation asks.
import { isMotionAllowed, loopRuns, motionAllowed } from '@/lib/motion-gate';
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

test('a loop (MeraLogo, shimmer, placeholders) runs only on screen with motion allowed', () => {
    const lite = isMotionAllowed(true, false);
    expect(loopRuns(true, lite)).toBe(false); // MeraLogo in Lite: still
    expect(loopRuns(true, true)).toBe(true);
    expect(loopRuns(false, true)).toBe(false); // off screen
    expect(loopRuns(true, true, true)).toBe(false); // the gallery's frozen tile
});
