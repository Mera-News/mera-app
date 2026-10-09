// The Profile chat's facts draft (ux2 F2), through the floating-chat store into the REAL
// facts-draft-service and combo-pass-service: only a chat opened FROM PROFILE opens a draft; the
// floating bubble never does; any close settles it. What is asserted is what the service persists
// (the two draft marker rows) and what the close does with a changed persona (the combination pass).
// Replaces lib/stores/__tests__/floating-chat-store-draft.test.ts (which mocked the service).
//
// Stays on the cloud path: a changed-facts close enqueues `topic_combo` jobs and clears the pending
// flag. On-device would start a feed sync instead.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import database from '@/lib/database';
import logger from '@/lib/logger';
import { isComboPending } from '@/lib/database/services/combo-pass-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { getSetting } from '@/lib/database/services/setting-service';
import {
  FACTS_DRAFT_FINGERPRINT_KEY,
  FACTS_DRAFT_OPEN_KEY,
  factsFingerprint,
  recoverOpenFactsDraft,
} from '@/lib/services/facts-draft-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { failSettingRead, failSettingWrite, restoreFaults, rowIs, settle, until } from './support';

const store = () => useFloatingChatStore.getState();
const profileChat = () => store().expand({ kind: 'persona', origin: 'profile' });

const comboJobs = async () =>
  (await database.get('inference_jobs').query().fetch()).filter((j: any) => j.jobType === 'topic_combo');
const draftRows = async () => ({
  open: await getSetting(FACTS_DRAFT_OPEN_KEY),
  fingerprint: await getSetting(FACTS_DRAFT_FINGERPRINT_KEY),
});

describe('the Profile chat facts draft', () => {
  beforeEach(() => store().reset());
  afterEach(async () => {
    restoreFaults();
    store().reset(); // a chat left open settles here, before the next test's database reset
    await settle();
  });

  it('opens a draft when the chat expands with origin profile: the open marker and the facts fingerprint', async () => {
    await addFact('I follow Formula 1');
    await addFact('I live in Utrecht');

    profileChat();

    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    const facts = await getFacts();
    expect(await getSetting(FACTS_DRAFT_FINGERPRINT_KEY)).toBe(
      factsFingerprint(facts.map((f) => ({ id: f.id, statement: f.statement }))),
    );
  });

  it('the floating bubble does not count', async () => {
    store().expand();
    store().expand({ kind: 'persona' });
    await settle();
    expect(await draftRows()).toEqual({ open: null, fingerprint: null });
  });

  it('any close (X, backdrop, swipe all collapse) settles the draft: both markers go, and an unchanged persona starts no pass', async () => {
    await addFact('I follow Formula 1');
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');

    store().collapse();

    await rowIs(FACTS_DRAFT_OPEN_KEY, null);
    await rowIs(FACTS_DRAFT_FINGERPRINT_KEY, null);
    await settle();
    expect(await isComboPending()).toBe(false);
    expect(await comboJobs()).toEqual([]);
  });

  it('a toggle that closes the chat settles it too', async () => {
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    store().toggle();
    await rowIs(FACTS_DRAFT_OPEN_KEY, null);
  });

  it('a close after the persona changed starts the combination pass: one topic_combo job per fact, the pending flag spent', async () => {
    await addFact('I follow Formula 1');
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    await addFact('I follow chess'); // edited while the chat was open

    store().collapse();

    await until(async () => (await comboJobs()).length === 2, 'a combo job per fact');
    expect((await comboJobs()).map((j: any) => j.status)).toEqual(['pending', 'pending']);
    expect(await isComboPending()).toBe(false);
    expect(await draftRows()).toEqual({ open: null, fingerprint: null });
  });

  it('an open that stays open settles nothing', async () => {
    profileChat();
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    await settle();
    expect((await draftRows()).open).toBe('1');
    expect((await draftRows()).fingerprint).not.toBeNull();
  });

  it('a later bubble open after a Profile chat is not a Profile chat', async () => {
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    store().collapse();
    await rowIs(FACTS_DRAFT_OPEN_KEY, null);

    store().expand(); // the bubble keeps the previous context, minus the Profile origin

    await settle();
    expect(await draftRows()).toEqual({ open: null, fingerprint: null });
  });

  it('a failed close is reported and leaves the open marker, which the next launch recovers', async () => {
    await addFact('I follow Formula 1');
    profileChat();
    await rowIs(FACTS_DRAFT_OPEN_KEY, '1');
    const err = new Error('read failed');
    failSettingRead(FACTS_DRAFT_OPEN_KEY, err);

    store().collapse();

    await until(
      () => (logger.captureException as jest.Mock).mock.calls.some((c) => c[1]?.tags?.area === 'facts-draft'),
      'the failed close to be reported',
    );
    expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { area: 'facts-draft' } });
    restoreFaults();
    expect((await draftRows()).open).toBe('1'); // still owed

    await addFact('I follow chess'); // the persona changed while the app was dead
    await expect(recoverOpenFactsDraft()).resolves.toBe(true);
    expect(await draftRows()).toEqual({ open: null, fingerprint: null });
    expect(await isComboPending()).toBe(true);
  });

  it('a failed open is reported too', async () => {
    const err = new Error('write failed');
    failSettingWrite(FACTS_DRAFT_FINGERPRINT_KEY, err);

    profileChat();

    await until(
      () => (logger.captureException as jest.Mock).mock.calls.some((c) => c[1]?.tags?.area === 'facts-draft'),
      'the failed open to be reported',
    );
    expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { area: 'facts-draft' } });
    expect((await draftRows()).open).toBeNull();
  });
});
