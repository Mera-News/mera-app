import React, { forwardRef, memo } from 'react';
import { H1, H2, H3, H4, H5, H6 } from '@expo/html-elements';
import { headingStyle } from './styles';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';
import { cssInterop } from 'nativewind';
import { tokenFromClassName } from '@/lib/typography/scale';
import { maxFontSizeMultiplierFor, type FontScaleTier } from '@/lib/typography/policy';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';

type IHeadingProps = VariantProps<typeof headingStyle> &
  React.ComponentPropsWithoutRef<typeof H1> & {
    as?: React.ElementType;
    /** See `lib/typography/policy.ts`. Defaults to `content`. */
    scaleTier?: FontScaleTier;
  };

cssInterop(H1, { className: 'style' });
cssInterop(H2, { className: 'style' });
cssInterop(H3, { className: 'style' });
cssInterop(H4, { className: 'style' });
cssInterop(H5, { className: 'style' });
cssInterop(H6, { className: 'style' });

/**
 * Which HTML heading element each size renders as.
 *
 * This was a seven-branch switch that repeated an identical 10-line
 * `headingStyle({...})` call in every arm; the only thing that varied was the
 * element. Collapsing it to a lookup is what makes it possible to compute the
 * resolved class, the scaled style and the Dynamic Type cap ONCE instead of
 * seven times.
 *
 * The mapping is shifted one step relative to the old switch, in lockstep with
 * the size map in `./styles.tsx`, so every call site renders the exact element
 * it rendered before the scale was reconciled. On native this is presentational
 * anyway — `@expo/html-elements` gives H1 through H6 the identical
 * `accessibilityRole: 'header'`, and the level only carries meaning on web,
 * which this app does not ship.
 */
const ELEMENT_FOR_SIZE = {
  '6xl': H1,
  '5xl': H1,
  '4xl': H1,
  '3xl': H2,
  '2xl': H3,
  'xl': H4,
  'lg': H5,
  'md': H6,
  'sm': H6,
  'xs': H6,
  '2xs': H6,
} as const;

type HeadingSize = keyof typeof ELEMENT_FOR_SIZE;

const MappedHeading = memo(
  forwardRef<React.ComponentRef<typeof H1>, IHeadingProps>(function MappedHeading(
    {
      size,
      className,
      isTruncated,
      bold,
      underline,
      strikeThrough,
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
    const Component = (size && ELEMENT_FOR_SIZE[size as HeadingSize]) || H4;

    const resolvedClass = headingStyle({
      size: size as HeadingSize | undefined,
      isTruncated: isTruncated as boolean,
      bold: bold as boolean,
      underline: underline as boolean,
      strikeThrough: strikeThrough as boolean,
      sub: sub as boolean,
      italic: italic as boolean,
      highlight: highlight as boolean,
      class: className,
    });

    // Read the token back out of the merged class string — see the same comment
    // in components/ui/text/index.tsx for why this beats deriving it from
    // `size`.
    const scaledStyle = React.useMemo(() => {
      const token = tokenFromClassName(resolvedClass);
      return token ? scaledTypeStyle(token, userScale) : undefined;
    }, [resolvedClass, userScale]);

    return (
      <Component
        className={resolvedClass}
        // Caller `style` last so an explicit override at a call site still wins.
        style={scaledStyle ? [scaledStyle, style] : style}
        maxFontSizeMultiplier={maxFontSizeMultiplierFor(scaleTier, userScale)}
        {...props}
        // @ts-expect-error The forwarded ref is typed for the generic
        // Heading element, but each Hn (@expo/html-elements) narrows its
        // own ref type; the union isn't expressible without patching the
        // lib. Same Gluestack v4 polymorphic-ref limitation as icon/index.web.tsx.
        ref={ref}
      />
    );
  })
);

const Heading = memo(
  forwardRef<React.ComponentRef<typeof H1>, IHeadingProps>(function Heading(
    { className, size = 'xl', as: AsComp, ...props },
    ref
  ) {
    const {
      isTruncated,
      bold,
      underline,
      strikeThrough,
      sub,
      italic,
      highlight,
    } = props;

    if (AsComp) {
      return (
        <AsComp
          className={headingStyle({
            size: size as HeadingSize | undefined,
            isTruncated: isTruncated as boolean,
            bold: bold as boolean,
            underline: underline as boolean,
            strikeThrough: strikeThrough as boolean,
            sub: sub as boolean,
            italic: italic as boolean,
            highlight: highlight as boolean,
            class: className,
          })}
          {...props}
        />
      );
    }

    return (
      <MappedHeading className={className} size={size} ref={ref} {...props} />
    );
  })
);

Heading.displayName = 'Heading';

export { Heading };
