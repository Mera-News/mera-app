// The daily follow-instead detector and the AI check's decoder, both pure.
import {
  analyzeHygiene,
  detectFollowInstead,
  followInsteadProposal,
  isNoStakeOffer,
  type FollowInsteadFactInput,
  type FollowInsteadRow,
  type HygieneTopicInput,
} from '@/lib/news-harness/persona-management/fact-hygiene';
import { decodeStakeCheck, stakeCheckRequest, STAKE_RULE } from '@/lib/news-harness/persona-management/stake-check';

const fact = (id: string, statement: string, over: Partial<FollowInsteadFactInput> = {}): FollowInsteadFactInput => ({
  id,
  statement,
  questionnaireAttribute: 'topics',
  isInterest: true,
  newsStopped: false,
  ...over,
});

const topic = (id: string, factId: string | null, text = id, over: Partial<HygieneTopicInput> = {}): HygieneTopicInput => ({
  id,
  factId,
  text,
  normalizedText: text.toLowerCase(),
  weight: 1,
  status: 'active',
  lastSignalAtMs: null,
  ...over,
});

/** `n` stories on one topic, each one row: judged, under the gate, unopened. */
const rows = (topicId: string, n: number, over: Partial<FollowInsteadRow> = {}): FollowInsteadRow[] =>
  Array.from({ length: n }, (_, i) => ({
    storyKey: `${topicId}-${i}`,
    topicIds: [topicId],
    opened: false,
    alreadyRead: false,
    judged: true,
    passedGate: false,
    ...over,
  }));

/** One fact per topic, each with a stake-free look only if the row passes the gate. */
const flooded = (extra: Partial<FollowInsteadRow> = {}) => ({
  facts: [
    fact('f-pop', 'Loves Katseye', { isInterest: false }),
    fact('f-a', 'Works at ASML', { isInterest: false, questionnaireAttribute: 'profession' }),
    fact('f-b', 'Sister lives in Pune', { isInterest: false, questionnaireAttribute: 'family' }),
    fact('f-c', 'Studies law', { isInterest: false, questionnaireAttribute: 'education' }),
  ],
  topics: [topic('katseye', 'f-pop'), topic('asml', 'f-a'), topic('pune', 'f-b'), topic('law', 'f-c')],
  rows: [
    ...rows('katseye', 40, extra),
    ...rows('asml', 5, { passedGate: true }),
    ...rows('pune', 6, { passedGate: true }),
    ...rows('law', 4, { passedGate: true }),
  ],
});

/** The four-fact account: 510 articles, 490 scored, top score 0.38. */
const fourFacts = () => {
  const names = ['tech', 'politics', 'climate', 'football'];
  return {
    facts: [
      fact('f-tech', 'Follows technology news'),
      fact('f-politics', 'Follows world politics news'),
      fact('f-climate', 'Follows climate news'),
      fact('f-football', 'Follows football'),
    ],
    topics: names.map((n) => topic(n, `f-${n}`)),
    rows: names.flatMap((n) => [
      ...rows(n, 122),
      ...rows(n, 5, { judged: false }).map((r, i) => ({ ...r, storyKey: `${n}-waiting-${i}` })),
    ]),
  };
};

describe('flooding', () => {
  it('fires on a topic that fills the feed and goes unread', () => {
    const [offer, ...rest] = detectFollowInstead(flooded());

    expect(offer).toMatchObject({ trigger: 'flood', factId: 'f-pop', topicIds: ['katseye'], subject: 'katseye', stories: 40 });
    expect(rest).toEqual([]);
  });

  it('stays silent on an even persona', () => {
    const even = flooded();
    even.rows = [...rows('katseye', 30), ...rows('asml', 30, { passedGate: true }), ...rows('pune', 30, { passedGate: true }), ...rows('law', 30, { passedGate: true })];

    expect(detectFollowInstead(even)).toEqual([]);
  });

  it('stays silent on a flooded topic the reader opens', () => {
    const open = flooded();
    open.rows = [...rows('katseye', 30, { opened: true }), ...rows('katseye', 10).map((r, i) => ({ ...r, storyKey: `more-${i}` })), ...open.rows.slice(40)];

    expect(detectFollowInstead(open)).toEqual([]);
  });

  it('counts by match: under the bar stays silent, and a copy of a story is one story', () => {
    const thin = flooded();
    thin.rows = [...rows('katseye', 19), ...rows('asml', 2, { passedGate: true }), ...rows('pune', 2, { passedGate: true }), ...rows('law', 1, { passedGate: true })];
    expect(detectFollowInstead(thin)).toEqual([]);

    const copies = flooded();
    copies.rows = [...rows('katseye', 40).map((r, i) => ({ ...r, storyKey: `same-${i % 10}` })), ...copies.rows.slice(40)];
    expect(detectFollowInstead(copies)).toEqual([]);
  });

  it('leaves already-read rows out of the opened share', () => {
    const read = flooded();
    // 30 of 40 were filtered as read; of the 10 left the reader opened 4, which is 40%.
    read.rows = [
      ...rows('katseye', 30, { alreadyRead: true }),
      ...rows('katseye', 4, { opened: true }).map((r, i) => ({ ...r, storyKey: `open-${i}` })),
      ...rows('katseye', 6).map((r, i) => ({ ...r, storyKey: `left-${i}` })),
      ...read.rows.slice(40),
    ];

    expect(detectFollowInstead(read)).toEqual([]);
  });
});

describe('no stake', () => {
  it('fires on all four facts of the four-fact account, each as the fact with all its topics', () => {
    const offers = detectFollowInstead(fourFacts());

    expect(offers).toHaveLength(4);
    expect(offers.every((o) => o.trigger === 'no_stake')).toBe(true);
    expect(offers.map((o) => o.factId).sort()).toEqual(['f-climate', 'f-football', 'f-politics', 'f-tech']);
    expect(offers.find((o) => o.factId === 'f-football')).toMatchObject({ statement: 'Follows football', topicIds: ['football'] });
  });

  it('stays silent on a fact with one story over the gate', () => {
    const one = fourFacts();
    one.facts = [one.facts[3]];
    one.topics = [one.topics[3]];
    one.rows = [...rows('football', 40), { ...rows('football', 1)[0], storyKey: 'one', passedGate: true }];

    expect(detectFollowInstead(one)).toEqual([]);
  });

  it('stays silent on a fact Mera has not judged yet: nothing scored is not nothing over the gate', () => {
    const waiting = fourFacts();
    waiting.rows = rows('football', 60, { judged: false });

    expect(detectFollowInstead(waiting)).toEqual([]);
  });

  it('never reads a fact that is not an interest', () => {
    const work = fourFacts();
    work.facts = work.facts.map((f) => ({ ...f, isInterest: false }));

    expect(detectFollowInstead(work).filter((o) => o.trigger === 'no_stake')).toEqual([]);
  });

  it('covers a fact across its topics: 20 stories split over them is enough', () => {
    const split = {
      facts: [fact('f', 'Follows football')],
      topics: [topic('t1', 'f'), topic('t2', 'f'), topic('t3', 'f')],
      rows: [...rows('t1', 8), ...rows('t2', 7), ...rows('t3', 5)],
    };

    expect(detectFollowInstead(split)).toMatchObject([{ trigger: 'no_stake', topicIds: ['t1', 't2', 't3'], stories: 20 }]);
  });
});

describe('what is never offered', () => {
  it('skips a home fact, a stopped fact, a followed topic and a story-bound topic', () => {
    const home = flooded();
    home.facts[0] = fact('f-pop', 'Lives in Seoul', { isInterest: false, questionnaireAttribute: 'location: home' });
    expect(detectFollowInstead(home)).toEqual([]);

    const stopped = flooded();
    stopped.facts[0] = fact('f-pop', 'Loves Katseye', { isInterest: false, newsStopped: true });
    expect(detectFollowInstead(stopped)).toEqual([]);

    const followed = flooded();
    followed.topics[0] = topic('katseye', null);
    expect(detectFollowInstead(followed)).toEqual([]);

    expect(detectFollowInstead({ ...flooded(), storyBoundTopicIds: ['katseye'] })).toEqual([]);
  });

  it('counts only active topics', () => {
    const retired = flooded();
    retired.topics[0] = topic('katseye', 'f-pop', 'katseye', { status: 'retired' });

    expect(detectFollowInstead(retired)).toEqual([]);
  });
});

describe('dismissal is final and keyed as the plan says', () => {
  it('a dismissed topic stays gone, on the normalised text, even if the row was minted again', () => {
    const [first] = detectFollowInstead(flooded());
    const id = followInsteadProposal(first, { label: 'Katseye', searchText: 'katseye' }, BLANK).id;

    const again = flooded();
    again.topics[0] = topic('new-id', 'f-pop', 'Katseye');
    again.rows = again.rows.map((r) => (r.topicIds[0] === 'katseye' ? { ...r, topicIds: ['new-id'] } : r));

    expect(id).toBe('follow_instead:topic:katseye');
    expect(detectFollowInstead({ ...again, rejectedFingerprints: [id] })).toEqual([]);
  });

  it('dismissing one topic does not block the fact', () => {
    const offers = detectFollowInstead({ ...fourFacts(), rejectedFingerprints: ['follow_instead:topic:football'] });

    expect(offers).toHaveLength(4);
  });

  it('dismissing a fact is final for its own topics too', () => {
    const rejected = ['follow_instead:fact:f-pop'];

    expect(detectFollowInstead({ ...flooded(), rejectedFingerprints: rejected })).toEqual([]);
  });

  it('a no-stake offer leads, then the bigger one', () => {
    const both = flooded();
    both.facts.push(fact('f-ball', 'Follows football'));
    both.topics.push(topic('ball', 'f-ball'));
    both.rows.push(...rows('ball', 25));

    expect(detectFollowInstead(both).map((o) => o.trigger)).toEqual(['no_stake', 'flood']);
  });
});

const BLANK = { origin: 'article', surface: 'follow-instead', articleId: '', title: '' } as const;

describe('the proposal', () => {
  it('a flood retires its topic and follows it, undoably', () => {
    const [c] = detectFollowInstead(flooded());
    const p = followInsteadProposal(c, { label: 'katseye', searchText: 'katseye' }, BLANK);

    expect(p).toMatchObject({
      kind: 'follow_instead',
      targetFactIds: ['f-pop'],
      targetTopicIds: ['katseye'],
      invertible: true,
      subject: { facts: ['Loves Katseye'], topics: ['katseye'] },
    });
    expect(p.ops[0]).toEqual({ type: 'follow_story', label: 'katseye', searchText: 'katseye', subject: BLANK });
    expect(p.ops.slice(1)).toEqual([{ type: 'persona_action', action: { action_type: 'retire_topic', topicId: 'katseye' } }]);
    expect(isNoStakeOffer(p)).toBe(false);
  });

  it('a no-stake offer deletes its fact, with no undo', () => {
    const [c] = detectFollowInstead(fourFacts());
    const p = followInsteadProposal(c, { label: 'Football', searchText: 'football' }, BLANK);

    expect(p.id).toBe(`follow_instead:fact:${c.factId}`);
    expect(p.invertible).toBe(false);
    expect(p.ops.slice(1)).toEqual([{ type: 'delete_fact', factId: c.factId }]);
    expect(isNoStakeOffer(p)).toBe(true);
  });

  it('the weekly analyzer never makes one', () => {
    const out = analyzeHygiene({ facts: [], topics: [], now: 0 });

    expect(out).toEqual([]);
  });
});

describe('the AI check', () => {
  it('asks with the rule the chat save uses, word for word', () => {
    expect(STAKE_RULE).toMatch(/^Set has_stake true when they said how this touches/);
    expect(STAKE_RULE).toMatch(/Unsure is false\.$/);
    expect(stakeCheckRequest('Follows football').systemPrompt).toContain(STAKE_RULE);
    expect(stakeCheckRequest('Follows football').prompt).toContain('Follows football');
  });

  it('reads false, with a subject and an English search', () => {
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Football","search":"football"}', 'Follows football')).toEqual({
      hasStake: false,
      subject: 'Football',
      search: 'football',
    });
  });

  it('capitalises the subject and searches on it when no search came back', () => {
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"cycling"}', 'Likes cycling')).toEqual({
      hasStake: false,
      subject: 'Cycling',
      search: 'Cycling',
    });
  });

  it('a stake, a missing value or a broken answer never makes an offer', () => {
    for (const raw of ['{"has_stake":true,"story_subject":"ASML"}', '{"story_subject":"ASML"}', '{"has_stake":"false"}', 'no', '']) {
      expect(decodeStakeCheck(raw, 'Works at ASML').hasStake).toBe(true);
    }
  });

  it('a personal phrase never reaches the follow topic', () => {
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"my football team"}', 'Follows football').subject).toBeNull();
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Football","search":"my team"}', 'Follows football').search).toBe('Football');
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Follows football"}', 'Follows football').subject).toBeNull();
  });

  it('a subject the fact never said is made up, and goes', () => {
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Formula 1"}', 'Is a nurse at Amsterdam UMC').subject).toBeNull();
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Unknown"}', 'Likes jazz').subject).toBeNull();
  });

  it('the English search may differ from the fact: only a personal one goes', () => {
    expect(decodeStakeCheck('{"has_stake":false,"story_subject":"Voetbal","search":"football"}', 'Volgt voetbal').search).toBe('football');
  });

  it('reads an answer wrapped in a code fence', () => {
    expect(decodeStakeCheck('```json\n{"has_stake":false,"story_subject":"Football"}\n```', 'Follows football').hasStake).toBe(false);
  });
});
