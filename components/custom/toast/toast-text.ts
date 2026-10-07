import { currentColors } from '@/lib/theme/tokens';

/**
 * Explicit text colours for toast bodies built outside the JSX className path.
 * The gluestack `ToastTitle` / `ToastDescription` primitives are NativeWind
 * className-styled, and a tree built with `React.createElement` bypasses that,
 * so their text rendered invisibly (icon-only toasts). Every toast the manager
 * builds uses plain RN `Text` with these instead.
 *
 * Call them inside the render callback so the colour follows the theme.
 */
export const toastTitleColor = (): string => currentColors().ink;
export const toastBodyColor = (): string => currentColors().ink2;
