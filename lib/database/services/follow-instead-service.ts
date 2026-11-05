// The daily follow-instead offer, RN adapter for the pure detector in
// fact-hygiene.ts. It runs inside `persona-geo-task` and adds no job, table or
// counter: it reads rows the product keeps to operate (matches on
// article_suggestions, opens on story_impressions, which ranking already reads),
// nothing leaves the phone but the fact to the AI check, and the result only
// proposes. Accepting lives in hygiene-service with the other accepts.

import { Q } from '@nozbe/watermelondb';

import { cloudComplete } from '../../llm/cloudComplete';
import { isOnDeviceMode } from '../../llm/on-device-gate';
import logger from '../../logger';
import { topicSkillForAttribute } from '../../mera-harness';
import { makeFollowStorySubject } from '../../news-harness/follow-story';
import {
  detectFollowInstead,
  followInsteadProposal,
  type FollowInsteadCandidate,
  type FollowInsteadRow,
} from '../../news-harness/persona-management/fact-hygiene';
import {
  STAKE_CHECK_CALL,
  capitalised,
  decodeStakeCheck,
  stakeCheckRequest,
  type StakeCheck,
} from '../../news-harness/persona-management/stake-check';
import { FEED_WINDOW_MS, relevancePassesGate } from '../../stores/fact-rows-selector';
import { ArticleSuggestionStatus } from '../article-suggestion-status';
import database from '../index';
import type ArticleSuggestionModel from '../models/ArticleSuggestion';
import { parseMatchedTopicRefs } from './article-suggestion-mappers';
import { getFacts, isNewsStopped } from './fact-service';
import { addFollowInsteadProposal, getFollowInsteadState } from './hygiene-service';
import { getSetting, setSetting } from './setting-service';
import { getAll as getImpressions } from './story-impression-service';
import { getAllTopicSnapshots } from './topic-service';
import { getActiveForTopicReconcile } from './tracked-story-service';

const LAST_SWEEP_KEY = 'follow_instead_last_sweep_at';

/** At most one offer a day. The task's own cadence is not this bound: a foreground
 *  can run it sooner, and a dismissal empties the queue the same day. */
const SWEEP_GAP_MS = 24 * 60 * 60 * 1000;

/** A persona full of real stakes costs this many small calls a day, no more. */
export const MAX_CHECKS_PER_SWEEP = 3;

export interface FollowInsteadSweepResult {
  offered: string | null;
  reason?: 'on_device' | 'cooldown' | 'waiting' | 'check_failed';
}

const VERDICTLESS = new Set<string>([
  ArticleSuggestionStatus.Unscored,
  ArticleSuggestionStatus.Excluded,
  ArticleSuggestionStatus.AlreadyRead,
]);

async function readRows(now: number): Promise<FollowInsteadRow[]> {
  const cutoff = now - FEED_WINDOW_MS;
  const [rows, impressions] = await Promise.all([
    database
      .get<ArticleSuggestionModel>('article_suggestions')
      .query(Q.where('first_pub_date', Q.gte(cutoff)))
      .fetch(),
    getImpressions(),
  ]);
  // Impressions live 30 days; only an open from this window speaks for these rows.
  const opened = new Set(
    impressions.filter((i) => i.opened && i.firstSeenAt.getTime() >= cutoff).map((i) => i.articleId),
  );
  return rows.map((r) => ({
    storyKey: r.storyKey ?? r.id,
    topicIds: parseMatchedTopicRefs(r.matchedTopicsJson).flatMap((t) => (t.topicId ? [t.topicId] : [])),
    opened: opened.has(r.id),
    alreadyRead: r.status === ArticleSuggestionStatus.AlreadyRead,
    judged: !VERDICTLESS.has(r.status) && (r.relevance > 0 || r.scoredAt != null),
    passedGate: relevancePassesGate({ scoredWithV3: r.scoredWithV3 === true, relevance: r.relevance }),
  }));
}

async function findCandidates(now: number, rejected: string[]): Promise<FollowInsteadCandidate[]> {
  const [facts, topics, stories, rows] = await Promise.all([
    getFacts(),
    getAllTopicSnapshots(),
    getActiveForTopicReconcile(),
    readRows(now),
  ]);
  return detectFollowInstead({
    facts: facts.map((f) => ({
      id: f.id,
      statement: f.statement,
      questionnaireAttribute: f.questionnaireAttribute,
      isInterest: topicSkillForAttribute(f.questionnaireAttribute) === 'topics/interest',
      newsStopped: isNewsStopped(f),
    })),
    topics,
    rows,
    storyBoundTopicIds: stories.map((s) => s.topicId),
    rejectedFingerprints: rejected,
  });
}

/** What the story is called and searched by, or null when the check found no way
 *  to follow it. A fact's subject comes from the check, because a fact is a phrase
 *  about the reader; a topic is already a search. */
function followOf(c: FollowInsteadCandidate, check: StakeCheck): { label: string; searchText: string } | null {
  if (check.hasStake) return null;
  if (c.trigger === 'flood') return { label: capitalised(c.subject), searchText: c.subject };
  return check.subject ? { label: check.subject, searchText: check.search ?? check.subject } : null;
}

/** Find one candidate worth offering, ask the AI check, publish at most one. Never throws. */
export async function runFollowInsteadSweep(opts?: { now?: number }): Promise<FollowInsteadSweepResult> {
  const now = opts?.now ?? Date.now();
  try {
    if (await isOnDeviceMode()) return { offered: null, reason: 'on_device' };
    const last = Number(await getSetting(LAST_SWEEP_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < SWEEP_GAP_MS) return { offered: null, reason: 'cooldown' };
    const { rejected, offerWaiting } = await getFollowInsteadState();
    if (offerWaiting) return { offered: null, reason: 'waiting' };

    const candidates = await findCandidates(now, rejected);
    let offered: string | null = null;
    for (const c of candidates.slice(0, MAX_CHECKS_PER_SWEEP)) {
      const raw = await cloudComplete({ ...stakeCheckRequest(c.statement), ...STAKE_CHECK_CALL });
      const follow = followOf(c, decodeStakeCheck(raw, c.statement));
      if (!follow) continue;
      const subject = { ...makeFollowStorySubject(), surface: 'follow-instead' };
      await addFollowInsteadProposal(followInsteadProposal(c, follow, subject));
      offered = c.id;
      break;
    }
    await setSetting(LAST_SWEEP_KEY, String(now));
    return { offered };
  } catch (error) {
    // Stamps nothing: like the geo sweep, a failed call is asked again next run.
    logger.warn('[follow-instead] sweep failed', { error: String(error) });
    return { offered: null, reason: 'check_failed' };
  }
}
