import { tva, isWeb } from '@gluestack-ui/utils/nativewind-utils';
const baseStyle = isWeb ? 'flex flex-col relative z-0' : '';

// One radius for every size. Gluestack coupled radius to padding (4 / 6 / 12px),
// which made a large card a different SHAPE from a small one; the app's surfaces
// are all 16px, so a card now reads as the same family whatever its size. Size
// keeps its padding, which is what it is actually for.
export const cardStyle = tva({
  base: baseStyle,
  variants: {
    size: {
      sm: 'p-3 rounded-2xl',
      md: 'p-4 rounded-2xl',
      lg: 'p-6 rounded-2xl',
    },
    variant: {
      // No plate here, and that is on purpose: `cardStyle` is a padded box, and
      // the plate needs an unpadded parent (see modal/index.tsx). A card that
      // wants the material composes `GlassPanel`, which already does it
      // correctly — `components/custom/cards/GlassPanel.tsx`. These two keep
      // their opaque fills so a Card with no plate is still a defined surface.
      elevated: 'bg-background-0',
      outline: 'border border-outline-200 ',
      ghost: 'rounded-none',
      filled: 'bg-background-50',
    },
  },
});
