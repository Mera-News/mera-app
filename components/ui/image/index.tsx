import React from 'react';
import { createImage } from '@gluestack-ui/core/image/creator';
import { Platform } from 'react-native';
import {
  Image as ExpoImage,
  type ImageContentFit,
  type ImageProps as ExpoImageProps,
} from 'expo-image';
import { cssInterop } from 'nativewind';
import { tva } from '@gluestack-ui/utils/nativewind-utils';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';

// expo-image is not a core RN primitive, so it doesn't get NativeWind's
// automatic className interop the way react-native's <Image> does — register
// it explicitly (same pattern as MotionView/UIProgress/PrimitiveIcon below).
cssInterop(ExpoImage, { className: 'style' });

const imageStyle = tva({
  base: 'max-w-full rounded-lg',
  variants: {
    size: {
      '2xs': 'h-6 w-6',
      'xs': 'h-10 w-10',
      'sm': 'h-16 w-16',
      'md': 'h-20 w-20',
      'lg': 'h-24 w-24',
      'xl': 'h-32 w-32',
      '2xl': 'h-64 w-64',
      'full': 'h-full w-full',
      'none': '',
    },
  },
});

/** react-native `Image`'s legacy resizeMode values — every existing caller in
 * this repo uses this prop shape, so the Root shim below maps it onto
 * expo-image's `contentFit`/`contentPosition` API rather than requiring call
 * sites to migrate. */
type RNResizeMode = 'cover' | 'contain' | 'stretch' | 'center' | 'repeat';

const RESIZE_MODE_TO_CONTENT_FIT: Record<RNResizeMode, ImageContentFit> = {
  cover: 'cover',
  contain: 'contain',
  stretch: 'fill',
  center: 'none',
  // expo-image has no tiling/repeat support — 'cover' is the closest
  // non-distorting visual fallback.
  repeat: 'cover',
};

/**
 * Root shim passed to Gluestack's `createImage`. Swaps react-native's
 * `Image` for expo-image's native `Image` while keeping every existing call
 * site (which passes RN-style `resizeMode`, `source`, `style`, `onError`,
 * `onLoad`, `alt`, `recyclingKey`, ...) working unchanged.
 */
const ExpoImageRoot = React.forwardRef<
  React.ComponentRef<typeof ExpoImage>,
  ExpoImageProps
>(function ExpoImageRoot(
  { resizeMode, contentFit, contentPosition, cachePolicy, transition, ...props },
  ref,
) {
  const resolvedContentFit =
    contentFit ?? (resizeMode ? RESIZE_MODE_TO_CONTENT_FIT[resizeMode] : undefined);
  const resolvedContentPosition =
    contentPosition ?? (resizeMode === 'center' ? 'center' : undefined);

  return (
    <ExpoImage
      ref={ref}
      contentFit={resolvedContentFit}
      contentPosition={resolvedContentPosition}
      cachePolicy={cachePolicy ?? 'memory-disk'}
      transition={transition ?? 150}
      {...props}
    />
  );
});
ExpoImageRoot.displayName = 'ExpoImageRoot';

const UIImage = createImage({ Root: ExpoImageRoot });

type ImageProps = VariantProps<typeof imageStyle> &
  React.ComponentProps<typeof UIImage>;
const Image = React.forwardRef<
  React.ComponentRef<typeof UIImage>,
  ImageProps & { className?: string }
>(function Image({ size = 'md', className, ...props }, ref) {
  return (
    <UIImage
      className={imageStyle({ size, class: className })}
      {...props}
      ref={ref}
      // @ts-expect-error : web only
      style={
        Platform.OS === 'web'
          ? { height: 'revert-layer', width: 'revert-layer' }
          : undefined
      }
    />
  );
});

Image.displayName = 'Image';
export { Image };
