// handleSaveExtractedFacts: the OFFER half of propose-then-save. It returns the cards' spine and
// writes nothing; the real filter rules run against the real fact table.
import { getFacts } from '@/lib/database/services/fact-service';
import { factChoiceGroupId } from '@/lib/chat-tools/fact-choice-resolution';
import { handleSaveExtractedFacts, MAX_FACT_LENGTH } from '@/lib/chat-tools/tool-handlers';
import '@/test/helpers';
import { resetChatModules, seedFacts } from '@/test/integration/chat/_helpers';
import { factStatements, queuedJobs, settle } from './kit';

beforeEach(() => {
  resetChatModules();
});

type Group = { index: number; groupId: string; options: string[]; questionnaireAttribute: string | null };
const groupsOf = (result: Record<string, unknown>) => result.pendingFacts as Group[];

it('MAX_FACT_LENGTH is 200', () => {
  expect(MAX_FACT_LENGTH).toBe(200);
});

describe('the empty offer', () => {
  const EMPTY = {
    success: true,
    staged: true,
    factsSaved: 0,
    savedFacts: [],
    conflicts: [],
    groupResolutions: {},
    pendingFacts: [],
  };

  it('an empty list, a missing key and a non-array all return the same staged empty result', async () => {
    expect(await handleSaveExtractedFacts({ extracted_user_information: [] })).toEqual(EMPTY);
    expect(await handleSaveExtractedFacts({})).toEqual(EMPTY);
    expect(await handleSaveExtractedFacts({ extracted_user_information: 'Lives in Porto' })).toEqual(EMPTY);
  });
});

describe('a good fact', () => {
  it('WRITES NOTHING: no fact, no topic job, and the staged shape reads factsSaved 0 with the marker', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['Lives in Amsterdam'] });
    await settle();

    expect(await getFacts()).toEqual([]);
    expect(await queuedJobs()).toEqual([]);
    // factsSaved: 0 is what stops the deriver reading the tool INPUT as "Saved to your persona".
    expect(result).toMatchObject({ staged: true, factsSaved: 0, savedFacts: [], conflicts: [], groupResolutions: {} });
    // groupId is asserted against the SAME function the resolver recomputes with: the round trip is
    // what proves a resolution written for this group can be found again.
    expect(groupsOf(result)).toEqual([
      {
        index: 0,
        groupId: factChoiceGroupId(0, ['Lives in Amsterdam']),
        options: ['Lives in Amsterdam'],
        questionnaireAttribute: null,
      },
    ]);
  });

  it('the groupResolutions marker is stamped at staging time, with facts or without', async () => {
    const withFacts = await handleSaveExtractedFacts({ extracted_user_information: ['Lives in Amsterdam'] });
    const withNone = await handleSaveExtractedFacts({ extracted_user_information: [] });
    expect(withFacts.groupResolutions).toEqual({});
    expect(withNone.groupResolutions).toEqual({});
  });

  it('carries the questionnaire attribute through to the card', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        { statement: 'Senior ML engineer', questionnaire_attribute: 'profession: job role and industry' },
      ],
    });
    expect(groupsOf(result)).toEqual([
      {
        index: 0,
        groupId: factChoiceGroupId(0, ['Senior ML engineer']),
        options: ['Senior ML engineer'],
        questionnaireAttribute: 'profession: job role and industry',
      },
    ]);
  });

  it('carries replaces and the topic skill on the spine, and nothing for a plain add', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        { statement: 'Lives in Berlin', replaces: 'old-fact-id', topic_skill_id: 'topics/residence' },
        'Plays chess',
      ],
    });
    const spine = result.pendingFacts as Record<string, unknown>[];
    expect(spine[0]).toMatchObject({ replaces: 'old-fact-id', topicSkillId: 'topics/residence' });
    expect(spine[1]).not.toHaveProperty('replaces');
    expect(spine[1]).not.toHaveProperty('topicSkillId');
  });

  it('offers alternatives as extra options on the SAME group', async () => {
    const options = ['Follows Sporting CP, the Portuguese football club', 'Interested in football clubs generally'];
    const result = await handleSaveExtractedFacts({
      extracted_user_information: [{ statement: options[0], alternatives: [options[1]] }],
    });
    expect(groupsOf(result)).toEqual([
      { index: 0, groupId: factChoiceGroupId(0, options), options, questionnaireAttribute: null },
    ]);
  });

  it('gives each distinct fact its own group, index and id', async () => {
    const result = await handleSaveExtractedFacts({
      extracted_user_information: ['Lives in Hoorn, Netherlands', 'Works as a farmer'],
    });
    const groups = groupsOf(result);
    expect(groups.map((g) => g.options)).toEqual([['Lives in Hoorn, Netherlands'], ['Works as a farmer']]);
    expect(groups.map((g) => g.index)).toEqual([0, 1]);
    // A shared id would collapse two facts onto one resolution slot.
    expect(groups[0].groupId).not.toBe(groups[1].groupId);
  });
});

describe('what is never offered', () => {
  // The accept/reject rules run BEFORE the card, so a reading that could never be saved is not
  // offered and then refused after the tap.
  it('a fact over MAX_FACT_LENGTH', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['x'.repeat(MAX_FACT_LENGTH + 1)] });
    expect(groupsOf(result)).toEqual([]);
  });

  it('a fact at exactly MAX_FACT_LENGTH', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['x'.repeat(MAX_FACT_LENGTH)] });
    expect(groupsOf(result)).toHaveLength(1);
  });

  it('empty and whitespace-only facts', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['   ', ''] });
    expect(groupsOf(result)).toEqual([]);
  });

  it('meta-conversational facts', async () => {
    const result = await handleSaveExtractedFacts({ extracted_user_information: ['User is setting up profile'] });
    expect(groupsOf(result)).toEqual([]);
  });

  it('an exact duplicate of a fact on file, case and spacing aside', async () => {
    await seedFacts(['Lives  in AMSTERDAM']);

    const result = await handleSaveExtractedFacts({ extracted_user_information: ['lives in amsterdam'] });

    expect(groupsOf(result)).toEqual([]);
    expect(await factStatements()).toEqual(['Lives  in AMSTERDAM']);
  });

  it('a duplicate READING is dropped but the rest of its group stays', async () => {
    await seedFacts(['Interested in football clubs generally']);

    const result = await handleSaveExtractedFacts({
      extracted_user_information: [
        { statement: 'Follows Sporting CP', alternatives: ['Interested in football clubs generally'] },
      ],
    });

    expect(groupsOf(result)).toEqual([
      {
        index: 0,
        groupId: factChoiceGroupId(0, ['Follows Sporting CP']),
        options: ['Follows Sporting CP'],
        questionnaireAttribute: null,
      },
    ]);
  });
});
