// The pako half of the blob probe is pure JS, so it can be answered here rather
// than on a device. Hermes and Node run the same pako code path — Hermes changes
// speed and memory, not control flow — so the onData CADENCE established here
// holds on-device. The RNFS half genuinely needs hardware and is not covered.
//
// This also pins the fixture, which is the part that bit: the first version of
// this probe used patterned data that deflated 512KB → ~15KB, under pako's 16KB
// output chunk. pako then correctly emitted ONE onData and the probe reported
// "buffered" — a false negative that would have sent the frame design the wrong
// way. The fixture must stay incompressible for this check to mean anything.

import { probePakoStreaming } from '../dev-probe';

describe('pako streaming under a JS engine', () => {
  const checks = probePakoStreaming();
  const byName = (needle: string) => checks.find((c) => c.name.includes(needle))!;

  it('round-trips chunked deflate → chunked inflate byte-exactly', () => {
    const c = byName('round-trips byte-exact');
    expect(c.pass).toBe(true);
  });

  it('emits onData incrementally rather than once at the final push', () => {
    // If this ever fails, do NOT relax it — pako buffering the whole stream
    // means the framing design's memory win is imaginary and the frame boundary
    // has to move, which is a design decision, not a test fix.
    const c = byName('INCREMENTALLY');
    expect(c.pass).toBe(true);
  });

  it('uses an incompressible fixture, or the check above is meaningless', () => {
    // Deflated size must be close to the input, not a fraction of it. A ratio
    // under ~0.5 means the fixture became squashable again and the onData check
    // has silently stopped testing anything.
    const detail = byName('round-trips byte-exact').detail;
    const [inBytes, outBytes] = (detail.match(/(\d+)B/g) ?? []).map((m) => parseInt(m, 10));
    expect(outBytes / inBytes).toBeGreaterThan(0.5);
  });
});
