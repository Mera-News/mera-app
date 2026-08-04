import { selectHistoryWindow, type HistoryRole } from '../history-window';

interface M {
  role: HistoryRole;
  tokens: number;
  tag?: string;
}

const u = (tokens = 10, tag?: string): M => ({ role: 'user', tokens, tag });
const a = (tokens = 10, tag?: string): M => ({ role: 'assistant', tokens, tag });
const t = (tokens = 10, tag?: string): M => ({ role: 'tool', tokens, tag });

function windowOf(
  entries: M[],
  budgetTokens: number,
  maxUserTurns = 6,
): M[] {
  const start = selectHistoryWindow<M>({
    entries,
    budgetTokens,
    maxUserTurns,
    roleOf: (m) => m.role,
    tokensOf: (m) => m.tokens,
  });
  return entries.slice(start);
}

describe('selectHistoryWindow', () => {
  describe('structural invariants', () => {
    it('always starts on a user turn', () => {
      const entries = [u(10), a(10), t(10), u(10), a(10), t(10), u(10)];
      for (const budget of [0, 5, 30, 100, 1000]) {
        expect(windowOf(entries, budget)[0].role).toBe('user');
      }
    });

    it('never splits an assistant(tool_calls) / tool result pair', () => {
      // A window that starts on a user turn can never begin partway through a
      // pair — this asserts the property directly for every budget.
      const entries = [u(10), a(50), t(50), u(10), a(50), t(50), u(10)];
      for (let budget = 0; budget <= 400; budget += 7) {
        const w = windowOf(entries, budget);
        w.forEach((m, i) => {
          if (m.role === 'tool') {
            expect(i).toBeGreaterThan(0);
            expect(w[i - 1].role).toBe('assistant');
          }
        });
      }
    });

    it('returns 0 when there is no user message to anchor on', () => {
      const entries = [a(10), t(10)];
      const start = selectHistoryWindow<M>({
        entries,
        budgetTokens: 1000,
        maxUserTurns: 6,
        roleOf: (m) => m.role,
        tokensOf: (m) => m.tokens,
      });
      expect(start).toBe(0);
    });

    it('handles an empty history', () => {
      expect(
        selectHistoryWindow<M>({
          entries: [],
          budgetTokens: 100,
          maxUserTurns: 6,
          roleOf: (m) => m.role,
          tokensOf: (m) => m.tokens,
        }),
      ).toBe(0);
    });
  });

  describe('the reported bug: a bare confirmation keeps its question', () => {
    it('carries the invitation and the assistant question alongside "Yes"', () => {
      // [user(invitation), assistant(question), user("Yes")] — the exact tail
      // that used to reach the model as the single word "Yes".
      const entries = [
        u(40, 'invitation'),
        a(30, 'question'),
        u(2, 'yes'),
      ];
      const w = windowOf(entries, 1500);
      expect(w.map((m) => m.tag)).toEqual(['invitation', 'question', 'yes']);
    });

    it('still sends the current turn when it alone blows the budget', () => {
      const entries = [u(10, 'old'), a(10), u(9999, 'huge')];
      const w = windowOf(entries, 100);
      expect(w.map((m) => m.tag)).toEqual(['huge']);
    });
  });

  describe('budget', () => {
    it('spends the budget newest-first and stops before exceeding it', () => {
      // Four 10-token user turns; a 25-token budget affords the last two.
      const entries = [u(10, '1'), u(10, '2'), u(10, '3'), u(10, '4')];
      expect(windowOf(entries, 25).map((m) => m.tag)).toEqual(['3', '4']);
    });

    it('a zero or negative budget keeps only the current user turn', () => {
      const entries = [u(10, '1'), a(10), u(10, '2')];
      expect(windowOf(entries, 0).map((m) => m.tag)).toEqual(['2']);
      expect(windowOf(entries, -500).map((m) => m.tag)).toEqual(['2']);
    });

    it('counts assistant and tool entries against the budget, not just user turns', () => {
      const entries = [u(10, '1'), a(100), t(100), u(10, '2')];
      // 220 total; only the last turn fits in 50.
      expect(windowOf(entries, 50).map((m) => m.tag)).toEqual(['2']);
      expect(windowOf(entries, 500).map((m) => m.tag)).toEqual(['1', undefined, undefined, '2']);
    });
  });

  describe('turn cap', () => {
    it('never exceeds maxUserTurns even with unlimited budget', () => {
      const entries = Array.from({ length: 20 }, (_, i) => u(1, String(i)));
      const w = windowOf(entries, 1_000_000, 6);
      expect(w).toHaveLength(6);
      expect(w[0].tag).toBe('14');
      expect(w[5].tag).toBe('19');
    });

    it('treats a cap below 1 as 1', () => {
      const entries = [u(1, '1'), u(1, '2')];
      expect(windowOf(entries, 1_000_000, 0).map((m) => m.tag)).toEqual(['2']);
    });
  });
});
