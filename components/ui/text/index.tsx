import React from 'react';

import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';
import { Text as RNText } from 'react-native';
import { textStyle } from './styles';
import { tokenFromClassName } from '@/lib/typography/scale';
import { MAX_FONT_SCALE, maxFontSizeMultiplierFor, type FontScaleTier } from '@/lib/typography/policy';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';

type ITextProps = React.ComponentProps<typeof RNText> &
  VariantProps<typeof textStyle> & {
    /**
     * How far OS Dynamic Type may grow this text. Defaults to `content`.
     * Pass `chrome` for labels in a row sized by its neighbours, and `locked`
     * for text inside a box whose height feeds a computed layout — see
     * `lib/typography/policy.ts`.
     */
    scaleTier?: FontScaleTier;
  };

const Text = React.forwardRef<React.ComponentRef<typeof RNText>, ITextProps>(
  function Text(
    {
      className,
      isTruncated,
      bold,
      underline,
      strikeThrough,
      size = 'md',
      sub,
      italic,
      highlight,
      scaleTier = 'content',
      style,
      ...props
    },
    ref
  ) {
    const userScale = useTextScale();
    const resolvedClass = textStyle({
      isTruncated: isTruncated as boolean,
      bold: bold as boolean,
      underline: underline as boolean,
      strikeThrough: strikeThrough as boolean,
      size: size as 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '2xs' | '5xl' | '6xl' | undefined,
      sub: sub as boolean,
      italic: italic as boolean,
      highlight: highlight as boolean,
      class: className,
    });

    // The token is read back out of the MERGED class string, not derived from
    // the `size` prop. Both idioms are in use across the app — `size="sm"` and
    // `className="text-sm"` — and tailwind-merge decides which one wins. Asking
    // the merged output what it will render is the only way to agree with
    // NativeWind in every case instead of re-implementing its precedence.
    const scaledStyle = React.useMemo(() => {
      const token = tokenFromClassName(resolvedClass);
      return token ? scaledTypeStyle(token, userScale) : undefined;
    }, [resolvedClass, userScale]);

    return (
      <RNText
        className={resolvedClass}
        // Caller `style` last so an explicit fontSize at a call site still wins.
        style={scaledStyle ? [scaledStyle, style] : style}
        maxFontSizeMultiplier={maxFontSizeMultiplierFor(scaleTier, userScale)}
        {...props}
        ref={ref}
      />
    );
  }
);

Text.displayName = 'Text';

export { Text };
