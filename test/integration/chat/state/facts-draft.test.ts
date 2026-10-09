// The Profile-chat facts draft: did a fact-editing chat change the persona, and is a combination
// pass owed? Real setting, fact and combo-pass services over the in-memory DB; the pass shows up as
// real `topic_combo` rows in inference_jobs.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import { isComboPending } from '@/lib/database/services/combo-pass-service';
import { addFact, deleteFact, getFacts, updateFact } from '@/lib/database/services/fact-service';
import * as settingService from '@/lib/database/services/setting-service';
import type InferenceJobModel from '@/lib/database/models/InferenceJob';
import {
  closeFactsDraft,
  FACTS_DRAFT_FINGERPRINT_KEY,
  FACTS_DRAFT_OPEN_KEY,
  factsFingerprint,
  openFactsDraft,
  recoverOpenFactsDraft,
  settleProfileChatClose,
} from '@/lib/services/facts-draft-service';
import { seedFacts } from '@/test/integration/chat/_helpers';

const { getSetting } = settingService;

const comboJobs = async (): Promise<InferenceJobModel[]> =>
  database.get<InferenceJobModel>('inference_jobs').query(Q.where('job_type', 'topic_combo')).fetch();

beforeEach(async () => {
  await seedFacts(['Lives in Porto', 'From India']);
});

describe('factsFingerprint', () => {
  it('ignores order and changes with any statement or id', () => {
    const a = factsFingerprint([{ id: 'a', statement: 'x' }, { id: 'b', statement: 'y' }]);
    const reordered = factsFingerprint([{ id: 'b', statement: 'y' }, { id: 'a', statement: 'x' }]);
    const edited = factsFingerprint([{ id: 'a', statement: 'x' }, { id: 'b', statement: 'z' }]);
    const renumbered = factsFingerprint([{ id: 'a', statement: 'x' }, { id: 'c', statement: 'y' }]);
    expect(a).toBe(reordered);
    expect(a).not.toBe(edited);
    expect(a).not.toBe(renumbered);
  });

  it('carries the fact count, so an empty persona and a one-fact one never collide', () => {
    expect(factsFingerprint([])).toMatch(/^0:/);
    expect(factsFingerprint([{ id: 'a', statement: 'x' }])).toMatch(/^1:/);
  });
});

describe('opening and closing a draft', () => {
  it('open leaves the open marker and a fingerprint of the facts as they are', async () => {
    await openFactsDraft();

    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBe('1');
    const facts = await getFacts();
    expect(await getSetting(FACTS_DRAFT_FINGERPRINT_KEY)).toBe(
      factsFingerprint(facts.map((f) => ({ id: f.id, statement: f.statement }))),
    );
  });

  it('an unchanged close reports false, owes nothing and clears both markers', async () => {
    await openFactsDraft();

    expect(await closeFactsDraft()).toBe(false);

    expect(await isComboPending()).toBe(false);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
    expect(await getSetting(FACTS_DRAFT_FINGERPRINT_KEY)).toBeNull();
    expect(await comboJobs()).toEqual([]);
  });

  it.each([
    ['an added fact', async () => void (await addFact('Works as a nurse'))],
    [
      'an updated fact',
      async () => {
        const [first] = await getFacts();
        await updateFact(first.id, { statement: 'Lives in Lisbon' });
      },
    ],
    [
      'a deleted fact',
      async () => {
        const [first] = await getFacts();
        await deleteFact(first.id);
      },
    ],
  ])('%s owes a combination pass', async (_name, change) => {
    await openFactsDraft();
    await change();

    expect(await closeFactsDraft()).toBe(true);

    expect(await isComboPending()).toBe(true);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
    expect(await getSetting(FACTS_DRAFT_FINGERPRINT_KEY)).toBeNull();
  });

  it('a close with no open draft does nothing', async () => {
    await addFact('Works as a nurse');

    expect(await closeFactsDraft()).toBe(false);
    expect(await isComboPending()).toBe(false);
  });

  it('a second session starts from the facts as they are then', async () => {
    await openFactsDraft();
    await addFact('Works as a nurse');
    expect(await closeFactsDraft()).toBe(true);

    await openFactsDraft(); // the pass is already owed; this session changes nothing
    expect(await closeFactsDraft()).toBe(false);
  });

  it('open and close fired back to back run in order: the close never reads a marker the open has not written', async () => {
    const opened = openFactsDraft();
    const closed = closeFactsDraft();
    await Promise.all([opened, closed]);

    expect(await closed).toBe(false);
    // Out of order, the close would find nothing, and the open would then leave its marker behind.
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
  });

  it('marks the pass pending BEFORE clearing the markers: a kill in between is re-detected on the next launch', async () => {
    await openFactsDraft();
    await addFact('Works as a nurse');
    const kill = jest.spyOn(settingService, 'deleteSetting').mockRejectedValueOnce(new Error('killed'));
    try {
      await expect(closeFactsDraft()).rejects.toThrow('killed');
    } finally {
      kill.mockRestore();
    }

    expect(await isComboPending()).toBe(true);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBe('1');

    // The next launch finds the draft still open and reaches the same verdict.
    expect(await recoverOpenFactsDraft()).toBe(true);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
  });
});

describe('the close path (settleProfileChatClose)', () => {
  it('an unchanged draft starts no pass', async () => {
    await openFactsDraft();

    await settleProfileChatClose();

    expect(await isComboPending()).toBe(false);
    expect(await comboJobs()).toEqual([]);
  });

  it('a changed draft enqueues one topic_combo job per fact, in one pass, and clears the pending flag', async () => {
    await openFactsDraft();
    await addFact('Works as a nurse');

    await settleProfileChatClose();

    const facts = await getFacts();
    const jobs = await comboJobs();
    expect(facts).toHaveLength(3);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'pending')).toBe(true);
    expect(jobs.map((j) => (j.payload as { factId: string }).factId).sort()).toEqual(facts.map((f) => f.id).sort());
    expect(new Set(jobs.map((j) => (j.payload as { passId: string }).passId)).size).toBe(1);
    expect(await isComboPending()).toBe(false);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
  });

  it('a second changed close supersedes the first pass that has not started', async () => {
    await openFactsDraft();
    await addFact('Works as a nurse');
    await settleProfileChatClose();
    const firstPass = (await comboJobs()).map((j) => (j.payload as { passId: string }).passId);

    await openFactsDraft();
    await addFact('Plays chess');
    await settleProfileChatClose();

    const jobs = await comboJobs();
    expect(jobs).toHaveLength(4);
    expect(jobs.some((j) => firstPass.includes((j.payload as { passId: string }).passId))).toBe(false);
  });
});

describe('recovering a draft a kill left open', () => {
  it('a different fingerprint on the next launch owes a pass, once', async () => {
    await openFactsDraft();
    await addFact('Works as a nurse');
    // (the app is killed here; the chat never closed)

    expect(await recoverOpenFactsDraft()).toBe(true);
    expect(await isComboPending()).toBe(true);
    expect(await recoverOpenFactsDraft()).toBe(false);
  });

  it('an unchanged draft clears quietly', async () => {
    await openFactsDraft();

    expect(await recoverOpenFactsDraft()).toBe(false);
    expect(await getSetting(FACTS_DRAFT_OPEN_KEY)).toBeNull();
    expect(await isComboPending()).toBe(false);
  });

  it('with no draft left open it does nothing', async () => {
    await addFact('Works as a nurse');
    expect(await recoverOpenFactsDraft()).toBe(false);
    expect(await isComboPending()).toBe(false);
  });
});
