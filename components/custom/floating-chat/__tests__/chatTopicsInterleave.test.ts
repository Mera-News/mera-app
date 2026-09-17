// The merged "Add all" topics card fills its ceiling ROUND-ROBIN across facts.
//
// Taking the first N in fact order is the obvious implementation and it is
// wrong: the first fact's topics would eat the whole budget and a fact the user
// just accepted would show nothing, which reads as "that one did not work".

/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => ({ Text: () => null }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: () => null },
  withTiming: (v: unknown) => v,
}));
jest.mock('@/components/custom/TranslatableDynamic', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('@/lib/chat-tools/tool-handlers', () => ({ retryTopicGeneration: jest.fn() }));
jest.mock('@/lib/database/services/fact-service', () => ({
  observeTopicsStatus: () => ({ subscribe: () => ({ unsubscribe: jest.fn() }) }),
}));
jest.mock('@/lib/database/services/topic-planning-service', () => ({
  generateMoreTopicsForFact: jest.fn(),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  observeByFact: jest.fn(),
}));
// topic-decline-service builds its collections at MODULE SCOPE, so importing
// the card reaches SQLiteAdapter and dies on `initializeJSI` before any test
// body runs. Mocked here rather than in the service, where module-scope
// collections are the right call.
jest.mock('@/lib/database/services/topic-decline-service', () => ({
  deleteTopicWithDecline: jest.fn(),
  undoPendingDelete: jest.fn(),
  UNDO_WINDOW_MS: 5000,
}));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatFactMutationVersion: () => 0,
}));

import { interleaveByFact, MERGED_TOPIC_CEILING } from '../ChatTopicsCard';

const chip = (id: string, factId: string) => ({ id, text: id, factId });

describe('interleaveByFact', () => {
  it('gives every fact a chip before any fact gets a second', () => {
    const rows = [
      chip('a1', 'A'),
      chip('a2', 'A'),
      chip('a3', 'A'),
      chip('a4', 'A'),
      chip('b1', 'B'),
      chip('b2', 'B'),
      chip('c1', 'C'),
    ];
    expect(interleaveByFact(rows, ['A', 'B', 'C'], 6).map((r) => r.id)).toEqual([
      'a1',
      'b1',
      'c1',
      'a2',
      'b2',
      'a3',
    ]);
  });

  it('preserves each fact OWN ranked order', () => {
    const rows = [chip('a1', 'A'), chip('a2', 'A'), chip('b1', 'B')];
    const out = interleaveByFact(rows, ['A', 'B'], 6).filter((r) => r.factId === 'A');
    expect(out.map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('never exceeds the ceiling', () => {
    const rows = Array.from({ length: 30 }, (_, i) => chip(`t${i}`, `f${i % 3}`));
    expect(interleaveByFact(rows, ['f0', 'f1', 'f2'], MERGED_TOPIC_CEILING)).toHaveLength(
      MERGED_TOPIC_CEILING,
    );
  });

  it('terminates when one fact runs out early, rather than stalling', () => {
    // B has a single topic; the loop must keep drawing from A instead of
    // spinning on the empty bucket.
    const rows = [chip('a1', 'A'), chip('a2', 'A'), chip('a3', 'A'), chip('b1', 'B')];
    expect(interleaveByFact(rows, ['A', 'B'], 6).map((r) => r.id)).toEqual([
      'a1',
      'b1',
      'a2',
      'a3',
    ]);
  });

  it('returns nothing when there are no rows yet', () => {
    expect(interleaveByFact([], ['A', 'B'], 6)).toEqual([]);
  });

  it('ignores a row whose fact is not in the card', () => {
    const rows = [chip('a1', 'A'), chip('z1', 'Z')];
    expect(interleaveByFact(rows, ['A'], 6).map((r) => r.id)).toEqual(['a1']);
  });
});
