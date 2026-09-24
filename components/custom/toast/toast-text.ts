/**
 * Explicit text colours for toast bodies built outside the JSX className path.
 * The gluestack `ToastTitle` / `ToastDescription` primitives are NativeWind
 * className-styled, and a tree built with `React.createElement` bypasses that,
 * so their text rendered invisibly (icon-only toasts). Every toast the manager
 * builds uses plain RN `Text` with these instead. Values mirror the dark ramp's
 * typography-900 / typography-600, what the primitives resolve to under JSX.
 * Constants only, so `lib/toast-manager.ts` can import it at module scope.
 */
export const TOAST_TITLE_COLOR = '#F5F5F5';
export const TOAST_BODY_COLOR = '#D4D4D4';
