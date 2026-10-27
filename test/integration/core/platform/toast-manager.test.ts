/**
 * toastManager and the toast queue as one mechanism. Every manager method lands in the single top
 * stack, BEHIND whatever card is already showing (FIFO, owner decision), and each toast carries its
 * tone, title, body and lifetime. Driven through the public toastManager API into the real queue
 * (`lib/toast/toast-queue.ts`); nothing is mounted. The queue entry's `render()` returns the React
 * element the deck would paint, and its props are read as data (no component runs).
 *
 * A strict fake clock moves only when the test drives it, so the 5 s error debounce and every
 * card lifetime are asserted to the millisecond.
 */
jest.mock('@/lib/logger', () => {
  const fns: Record<string, jest.Mock> = {};
  return {
    __esModule: true,
    default: new Proxy({}, { get: (_t, key: string) => (fns[key] ??= jest.fn()) }),
  };
});

import logger from '@/lib/logger';
import { TOAST_MIN_DURATION_MS, toastManager } from '@/lib/toast-manager';
import { closeAll, resetToastQueue, show, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import MeraToast from '@/components/custom/toast/MeraToast';
import UndoToast from '@/components/custom/toast/UndoToast';
import NotifiedToast, { NOTIFIED_TOAST_HOLD_MS } from '@/components/custom/notifications/NotifiedToast';
import { initI18nEn, useStrictClock } from '@/test/helpers';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';

const en = require('@/lib/locales/en.json');

type El = { type: unknown; props: Record<string, any> };
const entries = () => useToastQueue.getState().entries;
const ids = () => entries().map((entry) => entry.id);
/** What the deck would paint for the front card, as an element tree. */
const frontEl = () => entries()[0].render({ id: entries()[0].id }) as unknown as El;
// The simple toasts are a MeraToast whose props carry the text.
const titleOf = (el: El) => el.props.title;
const bodyOf = (el: El) => el.props.body;
const warn = logger.warn as jest.Mock;
const info = logger.info as jest.Mock;

const undoOpts = (over: Record<string, unknown> = {}) => ({
  title: 'Got it: feed updated',
  undoLabel: 'Undo',
  undoneTitle: 'Change undone',
  onUndo: () => undefined as void | boolean | Promise<void | boolean>,
  ...over,
});
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

beforeAll(initI18nEn);

beforeEach(() => {
  useStrictClock('2026-01-01T00:00:00Z');
  resetToastQueue();
  toastManager.setToastInstance(toastApi);
  toastManager.resetDebounce();
});

afterEach(() => closeAll());

describe('no instance', () => {
  beforeEach(() => toastManager.setToastInstance(null as never));

  it.each([
    ['showNetworkError', () => toastManager.showNetworkError()],
    ['showError', () => toastManager.showError('Oops', 'Something failed')],
    ['showSuccess', () => toastManager.showSuccess('Done', 'Saved!')],
    ['showInfo', () => toastManager.showInfo('For You')],
  ])('%s logs a warning and queues nothing when not initialized', (_name, call) => {
    call();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not initialized'));
    expect(ids()).toEqual([]);
  });
});

describe('showNetworkError', () => {
  it('queues one card for 4s with the localized title and default body', () => {
    toastManager.showNetworkError();
    expect(ids()).toHaveLength(1);
    expect(entries()[0].duration).toBe(4000);
    const el = frontEl();
    expect(titleOf(el)).toBe(en.errors.networkErrorTitle);
    expect(bodyOf(el)).toBe(en.errors.networkErrorBody);
  });

  it('is an error MeraToast', () => {
    toastManager.showNetworkError();
    const el = frontEl();
    expect(el.type).toBe(MeraToast);
    expect(el.props.tone).toBe('error');
  });

  it('uses a custom message when provided', () => {
    toastManager.showNetworkError('Custom network error message');
    expect(bodyOf(frontEl())).toBe('Custom network error message');
  });

  it('debounces: a second call within 5s is skipped, and 5s later it shows again', async () => {
    toastManager.showNetworkError();
    toastManager.showNetworkError();
    expect(ids()).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('debounced'));

    // The first card has left at 4s; a call at 4999ms is still inside the 5s window, so skipped.
    await jest.advanceTimersByTimeAsync(4999);
    expect(ids()).toEqual([]);
    toastManager.showNetworkError();
    expect(ids()).toEqual([]);
    expect(info).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    toastManager.showNetworkError();
    expect(ids()).toHaveLength(1);
  });

  it('allows a second call after resetDebounce()', () => {
    toastManager.showNetworkError();
    toastManager.resetDebounce();
    toastManager.showNetworkError();
    expect(ids()).toHaveLength(2);
  });
});

describe('showError', () => {
  it('queues a 4s error card with the given title and message', () => {
    toastManager.showError('My Error', 'My Message');
    expect(entries()[0].duration).toBe(4000);
    const el = frontEl();
    expect(el.props.tone).toBe('error');
    expect(titleOf(el)).toBe('My Error');
    expect(bodyOf(el)).toBe('My Message');
  });

  it('debounces: a second showError within 5s is skipped', () => {
    toastManager.showError('A', 'B');
    toastManager.showError('C', 'D');
    expect(ids()).toHaveLength(1);
    expect(titleOf(frontEl())).toBe('A');
  });
});

describe('showSuccess', () => {
  it('queues a 3s success card with the given title and message', () => {
    toastManager.showSuccess('Great Job!', 'Everything is fine');
    expect(entries()[0].duration).toBe(3000);
    const el = frontEl();
    expect(el.props.tone).toBe('success');
    expect(titleOf(el)).toBe('Great Job!');
    expect(bodyOf(el)).toBe('Everything is fine');
  });

  it('is NOT debounced: shows even after an error toast', () => {
    toastManager.showNetworkError(); // consumes the debounce
    toastManager.showSuccess('Done', 'Saved');
    expect(ids()).toHaveLength(2);
  });
});

describe('showInfo', () => {
  it('queues an info card for the shared minimum duration', () => {
    toastManager.showInfo('For You');
    // Derived, not hardcoded: this used to be 1500ms, which read as a flicker.
    expect(entries()[0].duration).toBe(TOAST_MIN_DURATION_MS);
    const el = frontEl();
    expect(el.props.tone).toBe('info');
    expect(titleOf(el)).toBe('For You');
  });

  it('omits the body when no message is given, and shows it when one is', () => {
    toastManager.showInfo('For You');
    expect(frontEl().props.body).toBeUndefined();
    closeAll();
    toastManager.showInfo('For You', 'Long-press hint');
    expect(bodyOf(frontEl())).toBe('Long-press hint');
  });

  it('is NOT debounced: shows even after an error toast', () => {
    toastManager.showNetworkError();
    toastManager.showInfo('For You');
    expect(ids()).toHaveLength(2);
  });

  it('never shows any toast for less than the readable minimum', () => {
    toastManager.showInfo('For You');
    toastManager.showSuccess('Saved', 'Done');
    toastManager.showError('Oops', 'Broke');
    expect(entries()).toHaveLength(3);
    for (const entry of entries()) {
      expect(entry.duration).toBeGreaterThanOrEqual(TOAST_MIN_DURATION_MS);
    }
  });
});

describe('one top stack', () => {
  it('has no bottom lane: the queue state is just the entries', () => {
    toastManager.showInfo('Hint');
    expect(Object.keys(useToastQueue.getState())).toEqual(['entries']);
  });

  it('queues the undo toast BEHIND a toast that is already showing', () => {
    const showing = show({ duration: 5000, render: () => null });
    toastManager.showUndoToast(undoOpts());
    expect(ids()).toHaveLength(2);
    expect(ids()[0]).toBe(showing);
  });

  it('lets the front toast run its own timeout when the undo toast arrives mid-read', async () => {
    const fewer = show({ duration: 6000, render: () => null });
    await jest.advanceTimersByTimeAsync(4300);
    toastManager.showUndoToast(undoOpts());
    await jest.advanceTimersByTimeAsync(1600);
    expect(ids()[0]).toBe(fewer);
    expect(ids()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(100);
    expect(ids()).toHaveLength(1);
    expect(ids()[0]).not.toBe(fewer);
  });

  it('queues an info toast BEHIND a toast that is already showing', () => {
    const showing = show({ duration: 5000, render: () => null });
    toastManager.showInfo('Thanks for the feedback');
    expect(ids()).toHaveLength(2);
    expect(ids()[0]).toBe(showing);
  });

  it('keeps every manager method in the same stack, in arrival order', () => {
    toastManager.showSuccess('Saved', 'Done');
    toastManager.showInfo('Hint');
    toastManager.showUndoToast(undoOpts({ title: 'Applied', undoneTitle: 'Undone' }));
    toastManager.showError('Oops', 'Broke');
    expect(ids()).toHaveLength(4);
    // The first arrival still holds the front slot (FIFO, owner decision).
    const seqs = entries().map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(titleOf(frontEl())).toBe('Saved');
  });
});

describe('the undo toast', () => {
  it('renders every undo toast through UndoToast, the leaf style, with the feedback testID', () => {
    toastManager.showUndoToast(undoOpts());
    const el = frontEl();
    expect(el.type).toBe(UndoToast);
    expect(el.props.undoTestID).toBe('feedback-undo');
    expect(entries()[0].duration).toBe(6000);
  });

  it("keeps a caller's own Undo testID", () => {
    toastManager.showUndoToast(
      undoOpts({ title: "You'll see less from AD.nl.", undoneTitle: undefined, undoTestID: 'article-menu-undo' }),
    );
    expect(frontEl().props.undoTestID).toBe('article-menu-undo');
  });

  it('closes itself on Undo when there is no undone title to swap to', async () => {
    const onUndo = jest.fn();
    toastManager.showUndoToast(undoOpts({ title: 'Less from AD.nl', undoneTitle: undefined, onUndo }));
    frontEl().props.onUndo();
    await flush();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
  });

  it.each([
    ['resolves false (a newer change owns the value)', async () => false],
    ['throws', async () => Promise.reject(new Error('revert failed'))],
  ])('claims nothing and closes when onUndo %s', async (_case, onUndo) => {
    toastManager.showUndoToast(undoOpts({ onUndo }));
    const id = ids()[0];
    await expect(frontEl().props.onUndo()).resolves.toBe(false);
    await flush();
    expect(ids()).not.toContain(id);
  });

  it.each([true, undefined])('swaps the SAME card to "Change undone" when onUndo returns %s, then leaves 1.4 s later', async (result) => {
    toastManager.showUndoToast(undoOpts({ onUndo: () => result }));
    const id = ids()[0];
    await expect(frontEl().props.onUndo()).resolves.toBe(true);
    expect(ids()).toEqual([id]);
    expect(frontEl().props).toMatchObject({ undone: true, undoneTitle: 'Change undone' });
    await jest.advanceTimersByTimeAsync(1399);
    expect(ids()).toEqual([id]);
    await jest.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual([]);
  });
});

// A notified toast ("Fact check ready", hygiene, calibration, the optimisation plan) must render
// its title and body WITH the context's values. The row it persists keeps the raw key plus
// `context` (the notification centre interpolates from it); the transient toast used to resolve
// the keys with no values at all, so the reader saw 'No published fact checks yet for
// "{{title}}".' (owner bug, ux1).
// The persisted row is read back from the real notification service on the in-memory DB:
// showNotifiedToast reaches notify() through a dynamic `await import()` (harness c8f043ab made
// those run under Jest).
describe('showNotifiedToast', () => {
  it('renders the fact-check body with the article title, never a raw placeholder', async () => {
    await toastManager.showNotifiedToast({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: 'factCheck.notify.bodyNone',
      context: { title: 'Budget vote delayed' },
    });
    const el = frontEl();
    expect(el.type).toBe(NotifiedToast);
    expect(el.props.title).toBe('Fact check ready');
    expect(el.props.body).toBe('No published fact checks yet for "Budget vote delayed".');
    expect(el.props.body).not.toMatch(/\{\{/);
  });

  it.each([
    ['update_available', undefined, 'info'],
    ['calibration', undefined, 'info'],
    ['on-device-fallback', undefined, 'warning'],
    ['fact_check_done', { outcome: 'found' }, 'success'],
    ['fact_check_done', { outcome: 'unavailable' }, 'warning'],
    ['something_new', undefined, 'neutral'],
  ])('takes its tone from the notice type (%s %j -> %s)', async (type, context, tone) => {
    await toastManager.showNotifiedToast({ type, source: 'test', title: 'T', body: 'B', context });
    expect(frontEl().props.tone).toBe(tone);
    expect(frontEl().props.icon).toBeDefined();
  });

  it('fly: false skips the flight: the card only holds, then the deck fades it like any toast', async () => {
    await toastManager.showNotifiedToast({
      type: 'update_available',
      source: 'ota',
      title: 'notificationCenter.update.availableTitle',
      body: 'notificationCenter.update.availableBody',
      fly: false,
    });
    expect(frontEl().props.fly).toBe(false);
    expect(entries()[0].duration).toBe(NOTIFIED_TOAST_HOLD_MS);
  });

  it('persists the row with the RAW keys and the context, so the inbox can re-resolve them', async () => {
    await toastManager.showNotifiedToast({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: 'factCheck.notify.bodyNone',
      context: { title: 'Budget vote delayed' },
    });
    const rows = await getNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: 'factCheck.notify.bodyNone',
      status: 'unread',
    });
    expect(JSON.parse(rows[0].contextJson!)).toEqual({ title: 'Budget vote delayed' });
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('still shows the toast, with no button, when persisting the row fails, and reports the failure', async () => {
    // A context that cannot be serialised makes the real notify() reject inside its DB write.
    const context: Record<string, unknown> = { title: 'Budget vote delayed' };
    context.self = context;
    await toastManager.showNotifiedToast({
      type: 'fact_check_done',
      source: 'fact-check',
      title: 'factCheck.notify.title',
      body: 'factCheck.notify.bodyNone',
      context,
      actions: [{ id: 'open', label: 'Open' }],
    });
    expect(await getNotifications()).toHaveLength(0);
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(TypeError), {
      tags: { component: 'ToastManager', method: 'showNotifiedToast.notify' },
    });
    const el = frontEl();
    expect(el.type).toBe(NotifiedToast);
    expect(el.props.title).toBe('Fact check ready');
    expect(el.props.button).toBeUndefined();
  });

  it('interpolates counts the same way (hygiene, calibration, the plan)', async () => {
    await toastManager.showNotifiedToast({
      type: 'hygiene',
      source: 'hygiene',
      title: 'hygiene.notificationTitle',
      body: 'hygiene.notificationBody',
      context: { count: 3 },
    });
    const body = frontEl().props.body as string;
    expect(body).not.toMatch(/\{\{/);
    expect(body).toMatch(/3/);
  });
});
