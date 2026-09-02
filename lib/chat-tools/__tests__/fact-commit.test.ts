// fact-commit — the WRITE half of propose-then-save.
//
// These assertions were `handleSaveExtractedFacts`'s until the tool stopped
// writing. They are kept as close to the originals as possible on purpose: the
// point of moving the body rather than rewriting it is that the post-tap
// behaviour stays the behaviour that shipped.
//
// The load-bearing one is `questionnaire`. `resolveUserLocationFact` keys on the
// attribute, so a residence fact that loses it here stops anchoring `userLocation`
// for every future topic run — a silent, wide regression with no error anywhere.

jest.mock('../../database/services/fact-service', () => ({
  addFact: jest.fn(),
  getFacts: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../database/services/geo-derivation-service', () => ({
  runGeoDerivationSweep: jest.fn(() => Promise.resolve({ ran: true, added: 0, reweighted: 0 })),
}));
const mockNotifyFactMutation = jest.fn();
jest.mock('../../stores/floating-chat-store', () => ({
  useFloatingChatStore: {
    getState: jest.fn(() => ({ notifyFactMutation: mockNotifyFactMutation })),
  },
}));
const mockTriggerTopicGeneration = jest.fn();
jest.mock('../tool-handlers', () => ({
  triggerTopicGeneration: (...args: unknown[]) => mockTriggerTopicGeneration(...args),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { commitFactChoices } from '../fact-commit';
import { addFact, getFacts } from '../../database/services/fact-service';
import { runGeoDerivationSweep } from '../../database/services/geo-derivation-service';

const mockAddFact = addFact as jest.Mock;
const mockGetFacts = getFacts as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFacts.mockResolvedValue([]);
});

describe('commitFactChoices', () => {
  it('writes the chosen reading and reports it back', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Lives in Amsterdam' });

    const result = await commitFactChoices([{ statement: 'Lives in Amsterdam' }]);

    expect(mockAddFact).toHaveBeenCalledWith('Lives in Amsterdam', undefined, undefined);
    expect(result.savedFacts).toEqual([{ id: 'f1', statement: 'Lives in Amsterdam' }]);
  });

  // THE REGRESSION GUARD. resolveUserLocationFact tier-1 and tier-2 both key on
  // questionnaireAttribute; losing it here strips userLocation from topic gen.
  it('passes the questionnaire attribute through to addFact', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Lives in Amsterdam' });

    await commitFactChoices([
      {
        statement: 'Lives in Amsterdam',
        questionnaire: { attribute: 'location: neighborhood/area, city, and country' },
      },
    ]);

    expect(mockAddFact).toHaveBeenCalledWith(
      'Lives in Amsterdam',
      undefined,
      expect.objectContaining({ attribute: 'location: neighborhood/area, city, and country' }),
    );
  });

  it('triggers topic generation ONCE for an N-fact commit', async () => {
    mockAddFact
      .mockResolvedValueOnce({ id: 'f1', statement: 'A fact' })
      .mockResolvedValueOnce({ id: 'f2', statement: 'B fact' });

    await commitFactChoices([{ statement: 'A fact' }, { statement: 'B fact' }]);

    // One batch, not one per card — the same single round trip a multi-fact
    // turn used to make.
    expect(mockTriggerTopicGeneration).toHaveBeenCalledTimes(1);
    // Asserted on the ENTRIES argument alone: this test is about batching, not
    // about the arity of the call, so a later options argument must not break
    // it. The D29 options bag is covered in its own test below.
    expect(mockTriggerTopicGeneration.mock.calls[0][0]).toEqual([
      { id: 'f1', statement: 'A fact' },
      { id: 'f2', statement: 'B fact' },
    ]);
  });

  it('carries NO onboarding exemption by default', async () => {
    // The default has to be "no exemption": every commit outside a wizard run
    // reaches the same function, and a truthy default would hand the entire
    // free cohort unmetered topic generation.
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'A fact' });

    await commitFactChoices([{ statement: 'A fact' }]);

    expect(mockTriggerTopicGeneration.mock.calls[0][1]).toEqual({
      onboardingRun: undefined,
    });
  });

  it('forwards the onboarding run token when one is supplied', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'A fact' });
    const token = { pretend: 'token' } as never;

    await commitFactChoices([{ statement: 'A fact' }], { onboardingRun: token });

    // Forwarded verbatim. `commitFactChoices` does not judge the token; only
    // `isOnboardingRunActive` does, against its private registry.
    expect(mockTriggerTopicGeneration.mock.calls[0][1]).toEqual({
      onboardingRun: token,
    });
  });

  it('notifies the fact mutation once, after every write', async () => {
    mockAddFact
      .mockResolvedValueOnce({ id: 'f1', statement: 'A fact' })
      .mockResolvedValueOnce({ id: 'f2', statement: 'B fact' });

    await commitFactChoices([{ statement: 'A fact' }, { statement: 'B fact' }]);

    expect(mockNotifyFactMutation).toHaveBeenCalledTimes(1);
  });

  it('kicks off the geo-derivation sweep after a real write', async () => {
    mockAddFact.mockResolvedValueOnce({ id: 'f1', statement: 'Lives in Amsterdam' });

    await commitFactChoices([{ statement: 'Lives in Amsterdam' }]);

    expect(runGeoDerivationSweep).toHaveBeenCalledWith({ force: true });
  });

  it('does nothing at all for an empty commit', async () => {
    const result = await commitFactChoices([]);

    expect(mockAddFact).not.toHaveBeenCalled();
    expect(mockTriggerTopicGeneration).not.toHaveBeenCalled();
    expect(runGeoDerivationSweep).not.toHaveBeenCalled();
    expect(result).toEqual({ savedFacts: [], conflicts: [] });
  });

  // A double tap, or a card resurrected after a failed durable write.
  it('is idempotent: an existing statement is reported, not re-added', async () => {
    mockGetFacts.mockResolvedValue([
      { id: 'existing', statement: 'Lives  in AMSTERDAM', questionnaireAttribute: null },
    ]);

    const result = await commitFactChoices([{ statement: 'lives in amsterdam' }]);

    expect(mockAddFact).not.toHaveBeenCalled();
    expect(result.savedFacts).toEqual([{ id: 'existing', statement: 'lives in amsterdam' }]);
    // Nothing fresh, so no second round of topic generation for a fact that
    // already has topics.
    expect(mockTriggerTopicGeneration).not.toHaveBeenCalled();
  });

  it('surfaces a conflict against a same-subject existing fact', async () => {
    mockGetFacts.mockResolvedValue([
      {
        id: 'old',
        statement: 'Lives in Berlin, Germany',
        questionnaireAttribute: 'location: residence',
      },
    ]);
    mockAddFact.mockResolvedValueOnce({ id: 'new', statement: 'Lives in Amsterdam, Netherlands' });

    const result = await commitFactChoices([
      {
        statement: 'Lives in Amsterdam, Netherlands',
        questionnaire: { attribute: 'location: residence' },
      },
    ]);

    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  // Conflict detection used to run ONCE per turn against the pre-batch bank, so
  // two facts extracted together could never conflict with each other.
  // Committing per card must not change that.
  it('never raises a conflict against a sibling committed from the same turn', async () => {
    mockGetFacts.mockResolvedValue([
      {
        id: 'sibling',
        statement: 'Lives in Berlin, Germany',
        questionnaireAttribute: 'location: residence',
      },
    ]);
    mockAddFact.mockResolvedValueOnce({ id: 'new', statement: 'Lives in Amsterdam, Netherlands' });

    const result = await commitFactChoices(
      [
        {
          statement: 'Lives in Amsterdam, Netherlands',
          questionnaire: { attribute: 'location: residence' },
        },
      ],
      { excludeFactIds: ['sibling'] },
    );

    expect(result.conflicts).toEqual([]);
  });
});
