/**
 * The toast's SEVERITY MAPPING, pinned.
 *
 * Toasts used to carry severity in a saturated background fill. They are now
 * frosted neutral panels (Apple Notification Center), so the signal moved onto
 * a leading accent bar plus a shape-distinct glyph — and that signal is exactly
 * the kind of thing that regresses invisibly, because nothing crashes when an
 * error toast silently stops looking like an error.
 *
 * These tests assert the two carriers exist, are the RIGHT colour, and are
 * absent for `muted`. They also guard the panel itself against the one change
 * that would quietly undo the whole look: an opaque background sat back on the
 * surface, which cancels glass.
 */
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import {
  TOAST_ACCENT,
  TOAST_ICON,
  TOAST_RADIUS,
  Toast,
  ToastDescription,
  ToastTitle,
  type ToastAction,
} from '@/components/ui/toast';

// `@legendapp/motion` is only the toast OVERLAY's animation driver — nothing
// here renders one. It is mocked because importing it for real drags in
// react-native's Animated ScrollView, whose `specs_DEPRECATED` modules are
// untransformed ESM under this config and die on `Unexpected token 'export'`.
// No existing suite imports the real toast module, so this is the first place
// it bites. The two symbols below are consumed at module scope by
// `createToastHook`, so the mock has to supply both. (Written below the imports
// for lint's sake — babel-jest hoists `jest.mock` above them regardless.)
jest.mock('@legendapp/motion', () => {
  const { View } = require('react-native');
  return {
    Motion: { View },
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  };
});

const SEVERITIES: ToastAction[] = ['error', 'warning', 'success', 'info'];

/** Flatten a testing-library node's style prop to a plain object. */
const styleOf = (node: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(node.props.style as never) ?? {}) as Record<string, unknown>;

describe('TOAST_ACCENT — the severity colour map', () => {
  it('pins one accent per severity, and none for muted', () => {
    expect(TOAST_ACCENT).toEqual({
      error: '#F37373',
      warning: '#FB954B',
      success: '#84D3A2',
      info: '#32B4F4',
      muted: null,
    });
  });

  it('gives every severity a DISTINCT colour — a shared accent carries no signal', () => {
    const accents = SEVERITIES.map((a) => TOAST_ACCENT[a]);
    expect(new Set(accents).size).toBe(SEVERITIES.length);
  });

  it('pairs every severity with a glyph, and muted with none', () => {
    for (const action of SEVERITIES) {
      expect(TOAST_ICON[action]).toBeTruthy();
    }
    expect(TOAST_ICON.muted).toBeNull();
  });

  it('gives every severity a DISTINCT glyph, so the signal survives colour blindness', () => {
    const glyphs = SEVERITIES.map((a) => TOAST_ICON[a]);
    expect(new Set(glyphs).size).toBe(SEVERITIES.length);
  });
});

describe('<Toast /> — how severity reaches the screen', () => {
  it.each(SEVERITIES)('renders a %s accent bar in the mapped colour', (action) => {
    const { getByTestId } = render(
      <Toast action={action} variant="solid">
        <ToastTitle>Title</ToastTitle>
        <ToastDescription>Body</ToastDescription>
      </Toast>,
    );

    expect(styleOf(getByTestId('toast-accent-bar')).backgroundColor).toBe(
      TOAST_ACCENT[action],
    );
  });

  it.each(SEVERITIES)('renders a %s glyph, hidden from assistive tech', (action) => {
    const { getByTestId } = render(
      <Toast action={action} variant="solid">
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );

    // `includeHiddenElements` is required precisely BECAUSE the glyph is hidden
    // from assistive tech — RNTL's default query skips such nodes, which is
    // itself corroboration that the hiding works.
    const icon = getByTestId('toast-accent-icon', { includeHiddenElements: true });
    // ToastTitle already announces via announceForAccessibility; a second,
    // wordless node would only add noise.
    expect(icon.props.accessibilityElementsHidden).toBe(true);
    expect(icon.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('renders NEITHER carrier for the neutral `muted` action', () => {
    const { queryByTestId } = render(
      <Toast action="muted" variant="solid">
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );

    // Absent, not transparent — a transparent bar would still take up space.
    expect(queryByTestId('toast-accent-bar')).toBeNull();
    expect(
      queryByTestId('toast-accent-icon', { includeHiddenElements: true }),
    ).toBeNull();
  });

  it('defaults to `muted` when no action is passed', () => {
    const { queryByTestId } = render(
      <Toast>
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );

    expect(queryByTestId('toast-accent-bar')).toBeNull();
  });

  it('still renders its children — the accent is additive, never a replacement', () => {
    const { getByText } = render(
      <Toast action="error" variant="solid">
        <ToastTitle>Network Error</ToastTitle>
        <ToastDescription>Unable to connect.</ToastDescription>
      </Toast>,
    );

    expect(getByText('Network Error')).toBeTruthy();
    expect(getByText('Unable to connect.')).toBeTruthy();
  });
});

describe('<Toast /> — the frosted panel itself', () => {
  it('carries no background colour on any severity — an opaque fill cancels glass', () => {
    for (const action of [...SEVERITIES, 'muted' as const]) {
      const { getByTestId, unmount } = render(
        <Toast testID="toast-root" action={action} variant="solid">
          <ToastTitle>Title</ToastTitle>
        </Toast>,
      );

      expect(styleOf(getByTestId('toast-root')).backgroundColor).toBeUndefined();
      unmount();
    }
  });

  it('frosts by default, but a `persistent` toast takes the flat fill instead', () => {
    // Not a look preference: a `duration: null` toast never goes away, and a
    // permanently-mounted GlassView re-blurs the animated backdrop every frame
    // forever. Both banner surfaces (OTAUpdatePrompt,
    // TranslationUnavailablePrompt) rely on this.
    const transient = render(
      <Toast action="info" variant="solid">
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );
    // Off iOS 26 — which is where jest runs — even a transient toast falls back
    // to the flat fill, because GlassPlate paints nothing there. What is being
    // pinned is that `persistent` NEVER takes the glass branch.
    transient.unmount();

    const { queryByTestId } = render(
      <Toast action="info" variant="solid" persistent>
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );
    expect(queryByTestId('toast-glass-scrim')).toBeNull();
    expect(queryByTestId('toast-flat-fill')).toBeTruthy();
  });

  it('rounds to the article cards’ radius', () => {
    const { getByTestId } = render(
      <Toast testID="toast-root" action="info" variant="solid">
        <ToastTitle>Title</ToastTitle>
      </Toast>,
    );

    expect(TOAST_RADIUS).toBe(16);
    expect(styleOf(getByTestId('toast-root')).borderRadius).toBe(TOAST_RADIUS);
  });
});
