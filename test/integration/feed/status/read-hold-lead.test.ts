// The counts card's limited state is the read hold (lib/subscription/read-hold), driven here through
// setReadHold / resetReadHold over the real stores. On-device reading is never held; the hold wins
// over a run in flight; the sentence names the unread articles only when a count is known.
import { act, renderHook } from '@testing-library/react-native';
import { resetStatusCard, setNotReadWaiting } from '@/components/custom/for-you/feed-status-card';
import { limitUnlockTime } from '@/components/custom/for-you/FeedStatusDetails';
import { useStatsCardLead } from '@/components/custom/for-you/use-stats-card-lead';
import { useReadHeld } from '@/components/custom/cards/use-read-held';
import { addFact } from '@/lib/database/services/fact-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { resetFeedCountsMemoForTest } from '@/lib/hooks/use-feed-counts';
import i18n from '@/lib/i18n';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { initI18nEn } from '@/test/helpers';
import { resetFeedSyncMemory, resetScoringWorld } from '../../data/feed-sync/steps/support';

jest.setTimeout(60_000);

const HOUR = 3_600_000;
/** Local noon: "today" and "tomorrow" cannot flip under the test near midnight. */
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime();
const t = i18n.t.bind(i18n) as unknown as (key: string, options?: object) => string;

async function renderLead() {
  const view = renderHook(() => useStatsCardLead());
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  });
  return view;
}

describe('the counts card while the read hold is set', () => {
  beforeEach(async () => {
    await initI18nEn();
    resetFeedSyncMemory();
    await resetScoringWorld();
    await addFact('I follow racing');
    resetFeedCountsMemoForTest();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
  });
  beforeEach(() => {
    // Only the clock is faked; timers and promises stay real for the stores.
    jest.useFakeTimers({
      now: NOON,
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance',
        'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    resetReadHold();
    setNotReadWaiting(null);
    resetStatusCard();
    useForYouStore.setState({ asyncJobPhase: 'idle', articleCount: 0 });
  });

  it('is limited, and names the unread articles when a count is known', async () => {
    const resetAt = NOON + 2 * HOUR;
    await setReadHold({ resetAt });
    setNotReadWaiting(3);
    const { result } = await renderLead();
    expect(result.current.mode).toBe('limited');
    expect(result.current.zeroText).toBe(
      t('feed.readHold.waitingToday', { count: 3, formatted: '3', time: limitUnlockTime(resetAt) }),
    );
  });

  it('states the gap with numbers when the day\'s articles and the waiting count are known', async () => {
    const resetAt = NOON + 2 * HOUR;
    await setReadHold({ resetAt });
    useForYouStore.setState({ articleCount: 120 });
    setNotReadWaiting(80);
    const { result } = await renderLead();
    expect(result.current.zeroText).toBe(
      [
        t('feed.readHold.gapFound', { count: 120, formatted: '120', read: '0' }),
        t('feed.readHold.gapWaiting', { count: 80, formatted: '80' }),
        t('feed.readHold.gapResetToday', { time: limitUnlockTime(resetAt) }),
      ].join(' '),
    );
    expect(result.current.zeroText).toMatch(/^Mera found 120 articles for you today and read 0\. 80 are still waiting\. Mera reads again today at /);
    expect(result.current.gap).toEqual({ read: 0, waiting: 80 });
  });

  it('uses the count-less sentence when nothing is known to be waiting', async () => {
    const resetAt = NOON + 2 * HOUR;
    await setReadHold({ resetAt });
    const { result } = await renderLead();
    expect(result.current.zeroText).toBe(t('feed.readHold.bodyToday', { time: limitUnlockTime(resetAt) }));
  });

  it('says tomorrow when the reset is not on the phone\'s date today', async () => {
    const resetAt = Date.now() + 30 * HOUR;
    await setReadHold({ resetAt });
    const { result } = await renderLead();
    expect(result.current.zeroText).toBe(t('feed.readHold.bodyTomorrow', { time: limitUnlockTime(resetAt) }));
  });

  it('wins over a run in flight', async () => {
    useForYouStore.setState({ asyncJobPhase: 'relevance' });
    await setReadHold({ resetAt: Date.now() + 2 * HOUR });
    const { result } = await renderLead();
    expect(result.current.mode).toBe('limited');
    expect(result.current.state).toBe('limited');
  });

  it('is never limited when reading on the phone', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    await setReadHold({ resetAt: Date.now() + 2 * HOUR });
    const { result } = await renderLead();
    expect(result.current.mode).not.toBe('limited');
  });

  it('is not limited once the hold is cleared', async () => {
    await setReadHold({ resetAt: Date.now() + 2 * HOUR });
    await setReadHold({ resetAt: null });
    const { result } = await renderLead();
    expect(result.current.mode).not.toBe('limited');
  });

  it('the not-read line follows the same hold: held in the cloud, never on the phone', async () => {
    await setReadHold({ resetAt: NOON + 2 * HOUR });
    const cloud = renderHook(() => useReadHeld());
    expect(cloud.result.current).toEqual({ held: true, resetAt: NOON + 2 * HOUR });
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    const phone = renderHook(() => useReadHeld());
    expect(phone.result.current).toEqual({ held: false, resetAt: null });
  });
});

