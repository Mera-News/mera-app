/**
 * MeraToast, the one toast every caller renders, at its component seam: the layout rules the
 * component decides (full width, inline action vs pills under the text), every tone, and the
 * Undo toast's in-place "Change undone" swap through the real toast manager and queue.
 * Colour is asserted from style props (no class names), so these checks see what the device paints.
 */
import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import MeraToast, { TOAST_TONES, toastWidth, toneColor } from '@/components/custom/toast/MeraToast';
import { toastManager } from '@/lib/toast-manager';
import { closeAll, resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import { COLORS, tint } from '@/lib/theme/tokens';
import { initI18nEn, useStrictClock } from '@/test/helpers';

const c = COLORS.dark;
const entries = () => useToastQueue.getState().entries;
const ids = () => entries().map((e) => e.id);
// Decorative parts (the badge, the bar) are hidden from VoiceOver, so they are found with hidden elements.
const flat = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style);
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
/** Mounts what the deck would paint for the front card. */
const mountFront = () => {
  const e = entries()[0];
  return render(<>{e.render({ id: e.id })}</>);
};

beforeAll(initI18nEn);
beforeEach(() => {
  useStrictClock('2026-01-01T00:00:00Z');
  resetToastQueue();
  toastManager.setToastInstance(toastApi);
});
afterEach(() => closeAll());

describe('width', () => {
  it('is the screen less 16 on each side, capped at 440, never the text width', () => {
    expect(toastWidth(390)).toBe(358);
    expect(toastWidth(320)).toBe(288);
    expect(toastWidth(1024)).toBe(440);
    render(<MeraToast tone="info" title="Hi" />);
    expect(flat('mera-toast').width).toBe(toastWidth(Dimensions.get('window').width));
  });

  it('gives the text column the remaining width (flex 1, minWidth 0), so an action never squeezes it', () => {
    render(
      <MeraToast
        tone="info"
        title="Update ready"
        body="Restart now, or Mera will update the next time you open it."
        actions={[{ label: 'Restart', onPress: () => {}, primary: true }]}
      />,
    );
    expect(flat('mera-toast-text')).toMatchObject({ flex: 1, minWidth: 0 });
  });
});

describe('actions', () => {
  it('title only with one action: the action sits inline, 44 tall, with no action row', () => {
    const onPress = jest.fn();
    render(<MeraToast tone="error" title="Something went wrong" actions={[{ label: 'Retry', onPress, testID: 'retry' }]} />);
    expect(screen.queryByTestId('mera-toast-actions')).toBeNull();
    expect(flat('retry').minHeight).toBe(44);
    fireEvent.press(screen.getByTestId('retry'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('with a body, actions are pills under the text, secondary then primary, at most two', () => {
    render(
      <MeraToast
        tone="info"
        title="T"
        body="B"
        actions={[
          { label: 'Primary', onPress: () => {}, primary: true, testID: 'p' },
          { label: 'Secondary', onPress: () => {}, testID: 's' },
          { label: 'Third', onPress: () => {}, testID: 'x' },
        ]}
      />,
    );
    const row = screen.getByTestId('mera-toast-actions');
    expect(StyleSheet.flatten(row.props.style).justifyContent).toBe('flex-end');
    expect(screen.queryByTestId('x')).toBeNull();
    const order = row.props.children.map((child: React.ReactElement<{ testID: string }>) => child.props.testID);
    expect(order).toEqual(['s', 'p']);
    // The primary pill is the accent fill; the secondary is outlined.
    expect(flat('p-pill').backgroundColor).toBe(c.accent);
    expect(flat('s-pill').borderWidth).toBe(1);
    // Both keep a 44pt target around their 36pt pill.
    expect(flat('p').minHeight).toBe(44);
    expect(flat('p-pill').height).toBe(36);
  });

  it('every action is its own button for VoiceOver, beside one text element for the message', () => {
    render(<MeraToast tone="success" title="Saved" body="In your Library" actions={[{ label: 'Undo', onPress: () => {} }]} />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByLabelText('Saved. In your Library')).toBeTruthy();
  });
});

describe('tones', () => {
  it.each(TOAST_TONES)('%s draws its badge in the tone at low alpha and no side stripe', (tone) => {
    render(<MeraToast tone={tone} title="T" />);
    const expected = tone === 'neutral' ? tint(c.ink, 0.1) : tint(toneColor(tone, c), 0.16);
    expect(flat('mera-toast-badge').backgroundColor).toBe(expected);
    expect(screen.queryByTestId('toast-accent-bar')).toBeNull();
  });

  it('maps tones to the semantic tokens', () => {
    expect(toneColor('success', c)).toBe(c.positive);
    expect(toneColor('error', c)).toBe(c.negative);
    expect(toneColor('warning', c)).toBe(c.warning);
    expect(toneColor('info', c)).toBe(c.info);
    expect(toneColor('neutral', c)).toBe(c.ink);
  });

  it('title and body use the semantic inks, at 15/20 and 14/20, clamped to 2 and 3 lines', () => {
    render(<MeraToast tone="info" title="Title" body="Body" />);
    const title = screen.getByText('Title');
    const body = screen.getByText('Body');
    expect(StyleSheet.flatten(title.props.style)).toMatchObject({ color: c.ink, fontSize: 15, lineHeight: 20 });
    expect(StyleSheet.flatten(body.props.style)).toMatchObject({ color: c.ink2, fontSize: 14, lineHeight: 20 });
    expect(title.props.numberOfLines).toBe(2);
    expect(body.props.numberOfLines).toBe(3);
  });

  it('progress draws a bar on the bottom edge', () => {
    render(<MeraToast tone="neutral" title="Updating all facts" body="Please wait" progress progressTestID="bar" />);
    expect(screen.getByTestId('bar', { includeHiddenElements: true })).toBeTruthy();
  });
});

describe('the undo toast', () => {
  const show = (onUndo: () => unknown) =>
    toastManager.showUndoToast({
      title: 'Showing fewer from AD.nl',
      undoLabel: 'Undo',
      undoneTitle: 'Change undone',
      undoTestID: 'article-menu-undo',
      onUndo: onUndo as () => void,
    });

  it('swaps to "Change undone" in place, holds it 1.4 s, then leaves', async () => {
    const onUndo = jest.fn(async () => true);
    show(onUndo);
    // Late in the card's own 6 s: the swap still gets its full hold.
    await act(() => jest.advanceTimersByTimeAsync(5900));
    mountFront();
    expect(screen.getByText('Showing fewer from AD.nl')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('article-menu-undo'));
      await flush();
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Change undone')).toBeTruthy();
    expect(screen.queryByTestId('article-menu-undo')).toBeNull();
    expect(ids()).toHaveLength(1);
    // A fresh mount (the deck's exit clone) shows the swapped content too.
    expect(entries()[0].render({ id: entries()[0].id })).toMatchObject({ props: { undone: true } });
    await act(() => jest.advanceTimersByTimeAsync(1399));
    expect(ids()).toHaveLength(1);
    await act(() => jest.advanceTimersByTimeAsync(1));
    expect(ids()).toEqual([]);
  });

  it('a refused undo (onUndo resolves false) leaves at once and claims nothing', async () => {
    show(async () => false);
    mountFront();
    await act(async () => {
      fireEvent.press(screen.getByTestId('article-menu-undo'));
      await flush();
    });
    expect(ids()).toEqual([]);
    expect(screen.queryByText('Change undone')).toBeNull();
  });

  it('a second tap during the undo runs it once', async () => {
    const onUndo = jest.fn(() => new Promise<boolean>((r) => setTimeout(() => r(true), 50)));
    show(onUndo);
    mountFront();
    fireEvent.press(screen.getByTestId('article-menu-undo'));
    fireEvent.press(screen.getByTestId('article-menu-undo'));
    await act(() => jest.advanceTimersByTimeAsync(50));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

describe('migrated manager toasts render', () => {
  it.each([
    ['showError', () => toastManager.showError('Could not save', 'Try again later'), 'Could not save', 'Try again later'],
    ['showSuccess', () => toastManager.showSuccess('Saved', 'Done'), 'Saved', 'Done'],
    ['showInfo', () => toastManager.showInfo('For You'), 'For You', null],
  ])('%s paints its title and body through MeraToast', (_name, call, title, body) => {
    toastManager.resetDebounce();
    call();
    mountFront();
    expect(screen.getByText(title)).toBeTruthy();
    if (body) expect(screen.getByText(body)).toBeTruthy();
    expect(screen.getByTestId('mera-toast')).toBeTruthy();
  });
});
