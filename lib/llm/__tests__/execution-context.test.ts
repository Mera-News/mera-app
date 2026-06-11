// Tests for lib/llm/execution-context.ts — pure logic, no I/O.

import {
  contextForCycleReason,
  type ExecutionContext,
} from '../execution-context';

describe('contextForCycleReason', () => {
  describe('background reasons', () => {
    it('maps phase1-done to background', () => {
      expect(contextForCycleReason('phase1-done')).toBe<ExecutionContext>('background');
    });

    it('maps phase2-done to background', () => {
      expect(contextForCycleReason('phase2-done')).toBe<ExecutionContext>('background');
    });

    it('maps silent-push to background', () => {
      expect(contextForCycleReason('silent-push')).toBe<ExecutionContext>('background');
    });
  });

  describe('foreground reasons', () => {
    it('maps app-resume to foreground', () => {
      expect(contextForCycleReason('app-resume')).toBe<ExecutionContext>('foreground');
    });

    it('maps scoring-pass to foreground', () => {
      expect(contextForCycleReason('scoring-pass')).toBe<ExecutionContext>('foreground');
    });
  });

  describe('exhaustiveness', () => {
    const backgroundReasons = ['phase1-done', 'phase2-done', 'silent-push'] as const;
    const foregroundReasons = ['app-resume', 'scoring-pass'] as const;

    it('returns background for all background reasons', () => {
      for (const reason of backgroundReasons) {
        expect(contextForCycleReason(reason)).toBe('background');
      }
    });

    it('returns foreground for all foreground reasons', () => {
      for (const reason of foregroundReasons) {
        expect(contextForCycleReason(reason)).toBe('foreground');
      }
    });

    it('covers all 5 expected reasons without overlap', () => {
      const allReasons = [...backgroundReasons, ...foregroundReasons];
      expect(allReasons).toHaveLength(5);
      const results = allReasons.map(contextForCycleReason);
      const backgroundCount = results.filter((r) => r === 'background').length;
      const foregroundCount = results.filter((r) => r === 'foreground').length;
      expect(backgroundCount).toBe(3);
      expect(foregroundCount).toBe(2);
    });
  });
});
