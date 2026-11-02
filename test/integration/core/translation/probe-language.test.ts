// probeLanguage: the probe list the download notice reads. Real translation-service and queue; the native translator, AppState and the clock
// are the only fakes. The queue runs one native call at a time, so a probe behind another waits for
// the first to settle: ordering below follows that, not the order the calls were started.
// Loaded here, not lazily by the setup's beforeEach: test/helpers/screen.ts registers RNTL hooks on first import.
import { setAppState } from '@/test/helpers';
import { currentProbe, probeLanguage } from '@/lib/hooks/use-language-switch';
import * as translationService from '@/lib/translation-service';
import { __resetTranslationStateForTests, NATIVE_SETTLE_CEILING_MS, PROBE_FAST_FAIL_MS } from '@/lib/translation-service';

const mockOnTranslateTask: jest.Mock = jest.requireMock('expo-translate-text').onTranslateTask;

// Every native call hangs until the test answers it.
const nativeAnswers: ((v: { translatedTexts: string }) => void)[] = [];
let answered = 0;
/** Leave the next native call unanswered: its probe ended by timeout instead. */
const abandonNext = () => answered++;

const flushQueue = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Answer the next native call, waiting for the queue to dispatch it first. */
async function answerNext(translatedTexts = 'ok') {
    await flushQueue();
    expect(nativeAnswers.length).toBeGreaterThan(answered);
    nativeAnswers[answered++]({ translatedTexts });
    await flushQueue();
}

// A clock that moves only when a test advances it. The harness's useFakeClock lets wall time leak
// into fake time (`advanceTimers: true`); under a loaded full run that leak fired the 20s probe
// timeout before the test's 19,999 ms step, and the probe left open then failed every later test
// (the probe list is module state). setImmediate stays real, so flushQueue still turns the queue.
function useStrictClock(now: string): void {
    jest.useFakeTimers({
        advanceTimers: false,
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        now: new Date(now),
    });
}

beforeEach(() => {
    useStrictClock('2026-10-09T10:00:00Z');
    __resetTranslationStateForTests();
    nativeAnswers.length = 0;
    answered = 0;
    mockOnTranslateTask.mockReset();
    mockOnTranslateTask.mockImplementation(
        () => new Promise((resolve) => nativeAnswers.push(resolve)),
    );
    setAppState('active');
});

// The download notice shows exactly while a probe call is open, so this is the
// whole contract: in while the call runs, out when it settles, either way.
test('tracks each probe from the call until it settles, newest first', async () => {
    expect(currentProbe()).toBeNull();

    // 'de' owns the single native slot; its own timeout (20s) is what ends it.
    const de = probeLanguage('de', 20_000);
    const fr = probeLanguage('fr');
    await flushQueue();
    expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);
    expect(mockOnTranslateTask).toHaveBeenCalledWith(expect.objectContaining({ targetLangCode: 'de' }));
    expect(currentProbe()?.code).toBe('fr');

    // A probe that settles at once (English needs no native call) leaves as the newest.
    const quick = probeLanguage('en');
    expect(currentProbe()?.code).toBe('en');
    await expect(quick).resolves.toBe('success');
    expect(currentProbe()?.code).toBe('fr');

    // The timeout is the one passed in, not the 90s default: still open one ms short of it.
    let deOutcome: string | undefined;
    void de.then((o) => (deOutcome = o));
    await jest.advanceTimersByTimeAsync(19_999);
    expect(deOutcome).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await flushQueue();
    expect(deOutcome).toBe('timeout');
    abandonNext();
    // The older probe left; the newer one is still open.
    expect(currentProbe()?.code).toBe('fr');
    // The abandoned call still holds the one slot until the settle ceiling after its timeout.
    await jest.advanceTimersByTimeAsync(NATIVE_SETTLE_CEILING_MS);

    await answerNext();
    await expect(fr).resolves.toBe('success');
    expect(currentProbe()).toBeNull();
});

test('a probe that fails still leaves the list', async () => {
    // A failure slower than PROBE_FAST_FAIL_MS is not retried, so one native call ends the probe.
    mockOnTranslateTask.mockImplementationOnce(
        () => new Promise((_r, reject) => setTimeout(() => reject(new Error('Unable to Translate')), PROBE_FAST_FAIL_MS)),
    );
    const ja = probeLanguage('ja');
    expect(currentProbe()?.code).toBe('ja');
    await jest.advanceTimersByTimeAsync(PROBE_FAST_FAIL_MS);
    await expect(ja).resolves.toBe('failed');
    expect(currentProbe()).toBeNull();
});

test('a probe that throws still leaves the list', async () => {
    // The real service never rejects (it reports 'failed'), so the throw is injected on the one call (R23).
    const spy = jest.spyOn(translationService, 'probeTranslationLanguage').mockRejectedValueOnce(new Error('cancelled'));
    try {
        await expect(probeLanguage('ja')).rejects.toThrow('cancelled');
        expect(currentProbe()).toBeNull();
    } finally {
        spy.mockRestore();
    }
});

test('a retry of the same language is a new probe', async () => {
    const first = probeLanguage('pl', 5_000);
    const stuck = currentProbe();
    const retry = probeLanguage('pl');
    expect(currentProbe()).not.toBe(stuck);
    expect(currentProbe()?.code).toBe('pl');
    const retryProbe = currentProbe();

    // The abandoned call times out; the retry is tracked by identity, so it stays open.
    await jest.advanceTimersByTimeAsync(5_000);
    await flushQueue();
    await expect(first).resolves.toBe('timeout');
    abandonNext();
    expect(currentProbe()).toBe(retryProbe);
    await jest.advanceTimersByTimeAsync(NATIVE_SETTLE_CEILING_MS);

    await answerNext();
    await expect(retry).resolves.toBe('success');
    expect(currentProbe()).toBeNull();
});

