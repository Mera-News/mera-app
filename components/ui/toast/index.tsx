'use client';
import React from 'react';
import { createToastHook } from '@gluestack-ui/core/toast/creator';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import {
  tva,
  withStyleContext,
  useStyleContext,
  type VariantProps,
} from '@gluestack-ui/utils/nativewind-utils';
import { cssInterop } from 'nativewind';
import {
  Motion,
  AnimatePresence,
  MotionComponentProps,
} from '@legendapp/motion';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react-native';

type IMotionViewProps = React.ComponentProps<typeof View> &
  MotionComponentProps<typeof View, ViewStyle, unknown, unknown, unknown>;

const MotionView = Motion.View as React.ComponentType<IMotionViewProps>;

const useToast = createToastHook(MotionView, AnimatePresence);
const SCOPE = 'TOAST';

cssInterop(MotionView, { className: 'style' });

/**
 * ## Why a toast carries no PER-SEVERITY background
 *
 * Every action used to be a saturated pastel pill (`bg-error-800` and friends —
 * light fills, because the dark ramp is inverted — with near-black text on top).
 * They read as a different design language from the rest of the app. One
 * neutral surface for every severity replaced them, which deleted the ONLY
 * thing that told an error apart from a confirmation — so the severity signal
 * MOVED rather than disappearing: see `TOAST_ACCENT` / `TOAST_ICON` below.
 *
 * That neutral surface was briefly LIQUID GLASS. It is not any more — the owner
 * called it ugly, and it now uses the same flat grey panel as the feed's
 * importance-filter dropdown (`MENU_PANEL_FILL`). Do not reintroduce
 * `GlassPlate` here; `components/ui/menu/index.tsx` records that a glass menu
 * was tried and rejected for the same surface, because page text read through
 * the labels even at a denser scrim.
 *
 * The `action` / `variant` variants are kept with EMPTY classes on purpose:
 * they still type `VariantProps` and still feed the style context that
 * `ToastTitle` / `ToastDescription` read, they just no longer paint anything.
 * The fill lives on `styles.surface`, one layer in, so the Root stays free to
 * carry the shadow (a view that clips cannot cast one).
 */
const toastStyle = tva({
  base: 'm-1 web:pointer-events-auto shadow-hard-5',
  variants: {
    action: {
      error: '',
      warning: '',
      success: '',
      info: '',
      muted: '',
    },

    variant: {
      solid: '',
      outline: '',
    },
  },
});

/** Corner radius, in points. `rounded-2xl` — the article cards' radius, so a
 *  toast reads as the same family of surface rather than a rounder cousin. */
export const TOAST_RADIUS = 16;

/** Width of the leading severity bar. */
const ACCENT_WIDTH = 4;

/**
 * The panel fill, taken verbatim from the feed's importance-filter dropdown —
 * `menuStyle`'s `bg-[#45434A]` in `components/ui/menu/index.tsx`, the grey the
 * owner picked to match the app's frosted header tone.
 *
 * COPIED, not shared: the menu expresses it as a Tailwind arbitrary class, which
 * cannot reference a TS constant. So the two can drift, and the only thing
 * stopping them is the cross-reference in each file — if you change one grey,
 * change the other.
 *
 * Flat and opaque on every platform: no `GLASS_AVAILABLE` branch, so a toast
 * looks identical on iOS 26, iOS 25 and Android, and a `persistent` banner
 * costs nothing to keep on screen.
 */
export const MENU_PANEL_FILL = '#45434A';

/** `border-outline-100` in the dark ramp (rgb(65,65,65)) — the same hairline
 *  the menu panel carries. */
const MENU_PANEL_BORDER = 'rgb(65,65,65)';

export type ToastAction = 'error' | 'warning' | 'success' | 'info' | 'muted';

/**
 * THE SEVERITY MAPPING. A frosted panel cannot carry severity in its fill, so
 * severity is carried by two things instead, both driven from this one map:
 *
 *  1. a full-height 4pt leading bar in the accent colour, and
 *  2. a SHAPE-DISTINCT glyph (`TOAST_ICON`) tinted the same colour.
 *
 * Two carriers, one of which survives colour blindness, is what keeps an error
 * unmistakable at a glance without reading the words.
 *
 * Values are the app's dark-mode ramp read out of
 * `components/ui/gluestack-ui-provider/config.ts`, picked per-hue for equal
 * brightness on a dark panel rather than by a single ramp step — the ramp is
 * not perceptually uniform (`success-500` is a dark forest green while
 * `error-500` is a bright coral, so success takes a lighter step).
 *
 * `muted` has no accent by design: it is the neutral default, and a grey bar
 * would be noise. Both the bar and the glyph are skipped entirely for it —
 * they are not rendered transparent, or they would still take up space.
 */
export const TOAST_ACCENT: Record<ToastAction, string | null> = {
  error: '#F37373', // error-500
  warning: '#FB954B', // warning-500
  success: '#84D3A2', // success-700
  info: '#32B4F4', // info-500
  muted: null,
};

/** Glyph per severity. Shapes are deliberately distinct from one another
 *  (triangle vs circle, ! vs ✓ vs i) so the signal does not rest on hue. */
export const TOAST_ICON: Record<
  ToastAction,
  React.ComponentType<{ size?: number; color?: string }> | null
> = {
  error: CircleAlert,
  warning: TriangleAlert,
  success: CircleCheck,
  info: Info,
  muted: null,
};

const styles = StyleSheet.create({
  /**
   * Android's elevation only. The iOS lift is `shadow-hard-5` on the Root's
   * className — the SAME class the filter menu's panel uses, so the two
   * surfaces sit off the page identically. It moved back to the class when the
   * glass went away: the softer inline shadow existed because a hard, offset
   * shadow reads as a smudge under a TRANSLUCENT panel, and this panel is
   * opaque again.
   */
  root: {
    elevation: 8, // Android
  },
  /** The clipped, rounded, FILLED surface. Separate from the Root because RN
   *  drops a view's shadow the moment that same view sets `overflow: hidden` —
   *  so the shadow lives on the Root and the clipping + fill live here. */
  surface: {
    borderRadius: TOAST_RADIUS,
    overflow: 'hidden',
    backgroundColor: MENU_PANEL_FILL,
    borderWidth: 1,
    borderColor: MENU_PANEL_BORDER,
  },
  accent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: ACCENT_WIDTH,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  /** Nudged down so the glyph's centre lands on the title's cap height rather
   *  than floating above it. */
  glyph: {
    paddingTop: 17,
    paddingLeft: 12,
  },
  content: {
    // `flexShrink`, NOT `flex: 1`. The overlay centers each toast at its
    // INTRINSIC width (ToastList: alignItems 'center', nothing stretches the
    // panel), so a flex-basis-0 column here measured ZERO wide and every toast
    // collapsed to an icon-only sliver — the 2026-08-05 prod incident. Shrink
    // lets long text yield to the Root's maxWidth cap and wrap, while short
    // toasts stay snug to their text.
    flexShrink: 1,
    paddingVertical: 16,
    paddingRight: 16,
    gap: 4,
  },
});

// `text-typography-900`, NOT `-0`. The dark ramp is inverted, so `typography-0`
// is rgb(23,23,23) — near black. It was correct while a toast was a light
// pastel pill; on the frosted dark panel it is invisible. Same reason the
// description below moved from `-50` to `-600`.
const toastTitleStyle = tva({
  base: 'text-typography-900 font-medium font-body tracking-md text-left',
  variants: {
    isTruncated: {
      true: '',
    },
    bold: {
      true: 'font-bold',
    },
    underline: {
      true: 'underline',
    },
    strikeThrough: {
      true: 'line-through',
    },
    size: {
      '2xs': 'text-2xs',
      'xs': 'text-xs',
      'sm': 'text-sm',
      'md': 'text-base',
      'lg': 'text-lg',
      'xl': 'text-xl',
      '2xl': 'text-2xl',
      '3xl': 'text-3xl',
      '4xl': 'text-4xl',
      '5xl': 'text-5xl',
      '6xl': 'text-6xl',
    },
  },
  parentVariants: {
    variant: {
      solid: '',
      outline: '',
    },
    action: {
      error: '',
      warning: '',
      success: '',
      info: '',
      muted: '',
    },
  },
  parentCompoundVariants: [
    {
      variant: 'outline',
      action: 'error',
      class: 'text-error-800',
    },
    {
      variant: 'outline',
      action: 'warning',
      class: 'text-warning-800',
    },
    {
      variant: 'outline',
      action: 'success',
      class: 'text-success-800',
    },
    {
      variant: 'outline',
      action: 'info',
      class: 'text-info-800',
    },
    {
      variant: 'outline',
      action: 'muted',
      class: 'text-background-800',
    },
  ],
});

const toastDescriptionStyle = tva({
  base: 'font-normal font-body tracking-md text-left',
  variants: {
    isTruncated: {
      true: '',
    },
    bold: {
      true: 'font-bold',
    },
    underline: {
      true: 'underline',
    },
    strikeThrough: {
      true: 'line-through',
    },
    size: {
      '2xs': 'text-2xs',
      'xs': 'text-xs',
      'sm': 'text-sm',
      'md': 'text-base',
      'lg': 'text-lg',
      'xl': 'text-xl',
      '2xl': 'text-2xl',
      '3xl': 'text-3xl',
      '4xl': 'text-4xl',
      '5xl': 'text-5xl',
      '6xl': 'text-6xl',
    },
  },
  parentVariants: {
    variant: {
      solid: 'text-typography-600',
      outline: 'text-typography-600',
    },
  },
});

const Root = withStyleContext(View, SCOPE);
type IToastProps = React.ComponentProps<typeof Root> & {
  className?: string;
  /**
   * This toast is shown with `duration: null` — it stays on screen until
   * something closes it. Set by `OTAUpdatePrompt` and
   * `TranslationUnavailablePrompt`.
   *
   * NOW PURELY DECLARATIVE. It used to force the flat fill instead of glass, for
   * a COST reason: a `UIVisualEffectView` re-samples its backdrop every frame
   * that backdrop changes, this app's backdrop animates continuously, and a
   * permanently-mounted glass panel therefore re-blurred forever (the measured
   * regression in `GlassSurface.tsx`). Every toast is a flat opaque panel now,
   * so there is no glass branch left to opt out of and the concern is moot.
   *
   * Kept rather than deleted: both callers pass it, it still documents which
   * toasts never dismiss themselves, and it is the natural hook if a future
   * surface change reintroduces a per-lifetime distinction.
   */
  persistent?: boolean;
} & VariantProps<typeof toastStyle>;

/**
 * Fraction of the screen width kept clear on EACH side of every toast.
 *
 * Toasts render in a full-width, centre-aligned overlay container, so without a
 * cap they stretch nearly edge to edge and sit on top of the screen chrome —
 * the top-left back button and the top-right notification bell both became
 * unreadable and untappable behind one. Capping the toast to the middle 60%
 * leaves both corners clear. A long message then WRAPS (the toast grows
 * downward) instead of widening.
 *
 * Applied as a measured pixel `maxWidth` rather than a percentage class: the
 * overlay nests the toast several Views deep, none of which carry an explicit
 * width, so a percentage would have nothing dependable to resolve against.
 */
export const TOAST_EDGE_INSET_RATIO = 0.2;

/**
 * A flat grey, rounded notification panel — the filter menu's surface.
 *
 * Layering, outside in — the order is load-bearing:
 *
 *  - `Root` owns the margin, the shadow and the width cap, and must NOT clip
 *    (a clipping view casts no shadow).
 *  - `styles.surface` is the rounded, clipping box, and carries the fill.
 *  - the accent bar is inside the clip, so it picks up the corner radius. It is
 *    `pointerEvents="none"` — `showUndoToast` puts a real `Pressable` in
 *    `children`, and an overlay that swallowed taps would silently kill it.
 *
 * Children are rendered untouched into `styles.content`. `showUndoToast` builds
 * its children with `React.createElement` (no NativeWind JSX transform), so its
 * flat `Text` / `Pressable` elements rely on this wrapper — not on classes of
 * their own — for their padding and 4pt rhythm.
 */
const Toast = React.forwardRef<React.ComponentRef<typeof Root>, IToastProps>(
  function Toast(
    {
      className,
      variant = 'solid',
      action = 'muted',
      persistent = false,
      style,
      children,
      ...props
    },
    ref
  ) {
    const { width } = useWindowDimensions();
    const maxWidth = Math.round(width * (1 - 2 * TOAST_EDGE_INSET_RATIO));
    const accent = TOAST_ACCENT[action as ToastAction] ?? null;
    const Glyph = TOAST_ICON[action as ToastAction] ?? null;
    // `persistent` is read only so it is not forwarded onto the host View as an
    // unknown prop; it no longer changes what is painted (see its doc above).
    void persistent;
    return (
      <Root
        ref={ref}
        className={toastStyle({ variant, action, class: className })}
        context={{ variant, action }}
        // Caller style last so a specific toast can still opt out.
        style={[styles.root, { maxWidth, borderRadius: TOAST_RADIUS }, style]}
        {...props}
      >
        <View testID="toast-surface" style={styles.surface}>
          {accent ? (
            <View
              testID="toast-accent-bar"
              pointerEvents="none"
              style={[styles.accent, { backgroundColor: accent }]}
            />
          ) : null}
          {/* The bar's width is reserved here rather than absorbed by the
              content's padding, so a `muted` toast (no bar) stays optically
              symmetrical instead of sitting 4pt off-centre. */}
          <View style={[styles.row, { paddingLeft: accent ? ACCENT_WIDTH : 0 }]}>
            {Glyph ? (
              // Hidden from assistive tech: ToastTitle already announces the
              // message via `announceForAccessibility`, and a second, wordless
              // node would only add noise.
              <View
                testID="toast-accent-icon"
                style={styles.glyph}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Glyph size={18} color={accent ?? undefined} />
              </View>
            ) : null}
            <View style={[styles.content, { paddingLeft: Glyph ? 10 : 16 }]}>
              {children}
            </View>
          </View>
        </View>
      </Root>
    );
  }
);

type IToastTitleProps = React.ComponentProps<typeof Text> & {
  className?: string;
} & VariantProps<typeof toastTitleStyle>;

const ToastTitle = React.forwardRef<
  React.ComponentRef<typeof Text>,
  IToastTitleProps
>(function ToastTitle({ className, size = 'md', children, ...props }, ref) {
  const { variant: parentVariant, action: parentAction } =
    useStyleContext(SCOPE);
  React.useEffect(() => {
    // Issue from react-native side
    // Hack for now, will fix this later
    AccessibilityInfo.announceForAccessibility(children as string);
  }, [children]);

  return (
    <Text
      {...props}
      ref={ref}
      aria-live="assertive"
      aria-atomic="true"
      role="alert"
      className={toastTitleStyle({
        size,
        class: className,
        parentVariants: {
          variant: parentVariant,
          action: parentAction,
        },
      })}
    >
      {children}
    </Text>
  );
});

type IToastDescriptionProps = React.ComponentProps<typeof Text> & {
  className?: string;
} & VariantProps<typeof toastDescriptionStyle>;

const ToastDescription = React.forwardRef<
  React.ComponentRef<typeof Text>,
  IToastDescriptionProps
>(function ToastDescription({ className, size = 'md', ...props }, ref) {
  const { variant: parentVariant } = useStyleContext(SCOPE);
  return (
    <Text
      ref={ref}
      {...props}
      className={toastDescriptionStyle({
        size,
        class: className,
        parentVariants: {
          variant: parentVariant,
        },
      })}
    />
  );
});

Toast.displayName = 'Toast';
ToastTitle.displayName = 'ToastTitle';
ToastDescription.displayName = 'ToastDescription';

export { useToast, Toast, ToastTitle, ToastDescription };
