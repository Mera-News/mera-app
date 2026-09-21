'use client';
import { createModal } from '@gluestack-ui/core/modal/creator';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';
import { tva, useStyleContext, withStyleContext } from '@gluestack-ui/utils/nativewind-utils';
import {
  AnimatePresence,
  createMotionAnimatedComponent,
  Motion,
  MotionComponentProps,
} from '@legendapp/motion';
import { cssInterop } from 'nativewind';
import React from 'react';
import { Pressable, ScrollView, View, ViewStyle } from 'react-native';
// Reaches UP into components/custom for the app's material. Deliberate: the
// translucent fill and the hairline edge have exactly one definition, and the
// alternative — copying the rgba into every primitive — is the drift the
// MENU_PANEL_FILL note in components/ui/toast/index.tsx already warns about.
// No cycle: GlassSurface imports only components/ui/box.
import {
  GLASS_EDGE,
  GLASS_OVER_CONTENT_FILL,
  TranslucentPlate,
} from '@/components/custom/GlassSurface';

type IAnimatedPressableProps = React.ComponentProps<typeof Pressable> &
  MotionComponentProps<typeof Pressable, ViewStyle, unknown, unknown, unknown>;

const AnimatedPressable = createMotionAnimatedComponent(
  Pressable
) as React.ComponentType<IAnimatedPressableProps>;
const SCOPE = 'MODAL';

type IMotionViewProps = React.ComponentProps<typeof View> &
  MotionComponentProps<typeof View, ViewStyle, unknown, unknown, unknown>;

const MotionView = Motion.View as React.ComponentType<IMotionViewProps>;

const UIModal = createModal({
  Root: withStyleContext(View, SCOPE),
  Backdrop: AnimatedPressable,
  Content: MotionView,
  Body: ScrollView,
  CloseButton: Pressable,
  Footer: View,
  Header: View,
  AnimatePresence: AnimatePresence,
});

cssInterop(AnimatedPressable, { className: 'style' });
cssInterop(MotionView, { className: 'style' });

const modalStyle = tva({
  base: 'group/modal w-full h-full justify-center items-center web:pointer-events-none',
  variants: {
    size: {
      xs: '',
      sm: '',
      md: '',
      lg: '',
      full: '',
    },
  },
});

const modalBackdropStyle = tva({
  base: 'absolute left-0 top-0 right-0 bottom-0 bg-background-dark web:cursor-default',
});

/**
 * ## Why the modal is a translucent PLATE, and why the backdrop had to darken
 *
 * A translucent panel was tried on the app's other small surfaces and rejected
 * TWICE, for one reason both times: page text read through the labels even at a
 * denser scrim. `components/ui/menu/index.tsx` records the menu version;
 * `components/ui/toast/index.tsx` records the toast version, which the owner
 * called ugly. A modal is a BIGGER translucent surface over BUSIER content than
 * either, so it would have failed harder.
 *
 * What makes it work here is not the plate, it is WHAT IS BEHIND IT. Cards and
 * `GlassPanel` read well because they float over the gradient backdrop; a modal
 * floats over a live screen full of text. So the BACKDROP does the work — it
 * animates to 0.78, not gluestack's 0.5 — and the plate is then translucent
 * against an already-darkened field rather than against raw page text.
 *
 * If body text ever reads through again, raise the backdrop before thinning the
 * plate: the plate's tint is the whole reason this surface is the same material
 * as the cards, and the check to run is a modal over the FEED, not over a
 * settings screen.
 *
 * ## The three-layer split, which is load-bearing
 *
 * 1. `UIModal.Content` owns the width and the shadow, and must NOT clip — RN
 *    drops a view's shadow the moment that view sets `overflow: hidden`. It
 *    carries the radius anyway, or the shadow is cast as a square.
 * 2. An inner UNPADDED box owns the radius, the clip and the edge. Unpadded is
 *    not a style preference: Yoga resolves an absolute child's insets against
 *    the parent's CONTENT box, so hanging the plate off a padded view leaves an
 *    unplated frame (see `GlassSurface.tsx`).
 * 3. The padding that used to live on Content moved inward, onto the box that
 *    wraps `children`.
 */
const modalContentStyle = tva({
  base: 'rounded-2xl shadow-hard-2',
  parentVariants: {
    size: {
      xs: 'w-[60%] max-w-[360px]',
      sm: 'w-[70%] max-w-[420px]',
      md: 'w-[80%] max-w-[510px]',
      lg: 'w-[90%] max-w-[640px]',
      full: 'w-full',
    },
  },
});

// Plain constants, NOT `tva`. These two carry no variants, and a `tva` style
// invoked with no argument throws "Cannot read property 'parentVariants' of
// undefined" — a render error no test here can see, because nothing renders a
// ModalContent in jest.
/** Layer 2: the clipping, radius-owning, UNPADDED host for the plate. */
const MODAL_SURFACE_CLASS = `rounded-2xl overflow-hidden ${GLASS_EDGE}`;
/** Layer 3: the padding gluestack had on Content. */
const MODAL_INNER_CLASS = 'p-6';

const modalBodyStyle = tva({
  base: 'mt-2 mb-6',
});

const modalCloseButtonStyle = tva({
  base: 'group/modal-close-button z-10 rounded data-[focus-visible=true]:web:bg-background-100 web:outline-0 cursor-pointer',
});

const modalHeaderStyle = tva({
  base: 'justify-between items-center flex-row',
});

const modalFooterStyle = tva({
  base: 'flex-row justify-end items-center gap-2',
});

type IModalProps = React.ComponentProps<typeof UIModal> &
  VariantProps<typeof modalStyle> & { className?: string };

type IModalBackdropProps = React.ComponentProps<typeof UIModal.Backdrop> &
  VariantProps<typeof modalBackdropStyle> & { className?: string };

type IModalContentProps = React.ComponentProps<typeof UIModal.Content> &
  VariantProps<typeof modalContentStyle> & { className?: string };

type IModalHeaderProps = React.ComponentProps<typeof UIModal.Header> &
  VariantProps<typeof modalHeaderStyle> & { className?: string };

type IModalBodyProps = React.ComponentProps<typeof UIModal.Body> &
  VariantProps<typeof modalBodyStyle> & { className?: string };

type IModalFooterProps = React.ComponentProps<typeof UIModal.Footer> &
  VariantProps<typeof modalFooterStyle> & { className?: string };

type IModalCloseButtonProps = React.ComponentProps<typeof UIModal.CloseButton> &
  VariantProps<typeof modalCloseButtonStyle> & { className?: string };

const Modal = React.forwardRef<React.ComponentRef<typeof UIModal>, IModalProps>(
  ({ className, size = 'md', ...props }, ref) => (
    <UIModal
      ref={ref}
      {...props}
      pointerEvents="box-none"
      className={modalStyle({ size, class: className })}
      context={{ size }}
    />
  )
);

const ModalBackdrop = React.forwardRef<
  React.ComponentRef<typeof UIModal.Backdrop>,
  IModalBackdropProps
>(function ModalBackdrop({ className, ...props }, ref) {
  return (
    <UIModal.Backdrop
      ref={ref}
      initial={{
        opacity: 0,
      }}
      animate={{
        // 0.78, not gluestack's 0.5 — see the note on modalContentStyle. The
        // plate above this is translucent, so this is what keeps the page's
        // text from reading through the panel.
        opacity: 0.78,
      }}
      exit={{
        opacity: 0,
      }}
      transition={{
        type: 'spring',
        damping: 18,
        stiffness: 250,
        opacity: {
          type: 'timing',
          duration: 250,
        },
      }}
      {...props}
      className={modalBackdropStyle({
        class: className,
      })}
    />
  );
});

const ModalContent = React.forwardRef<
  React.ComponentRef<typeof UIModal.Content>,
  IModalContentProps
>(function ModalContent({ className, size, children, ...props }, ref) {
  const { size: parentSize } = useStyleContext(SCOPE);

  return (
    <UIModal.Content
      ref={ref}
      initial={{
        opacity: 0,
        scale: 0.9,
      }}
      animate={{
        opacity: 1,
        scale: 1,
      }}
      exit={{
        opacity: 0,
      }}
      transition={{
        type: 'spring',
        damping: 18,
        stiffness: 250,
        opacity: {
          type: 'timing',
          duration: 250,
        },
      }}
      {...props}
      className={modalContentStyle({
        parentVariants: {
          size: parentSize,
        },
        size: size as 'full' | 'xs' | 'sm' | 'md' | 'lg' | undefined,
        class: className,
      })}
      pointerEvents="auto"
    >
      {/* Three layers, and the order matters — see modalContentStyle. */}
      <View className={MODAL_SURFACE_CLASS} style={{ backgroundColor: GLASS_OVER_CONTENT_FILL }}>
        <TranslucentPlate />
        <View className={MODAL_INNER_CLASS}>{children}</View>
      </View>
    </UIModal.Content>
  );
});

const ModalHeader = React.forwardRef<
  React.ComponentRef<typeof UIModal.Header>,
  IModalHeaderProps
>(function ModalHeader({ className, ...props }, ref) {
  return (
    <UIModal.Header
      ref={ref}
      {...props}
      className={modalHeaderStyle({
        class: className,
      })}
    />
  );
});

const ModalBody = React.forwardRef<
  React.ComponentRef<typeof UIModal.Body>,
  IModalBodyProps
>(function ModalBody({ className, ...props }, ref) {
  return (
    <UIModal.Body
      ref={ref}
      {...props}
      className={modalBodyStyle({
        class: className,
      })}
    />
  );
});

const ModalFooter = React.forwardRef<
  React.ComponentRef<typeof UIModal.Footer>,
  IModalFooterProps
>(function ModalFooter({ className, ...props }, ref) {
  return (
    <UIModal.Footer
      ref={ref}
      {...props}
      className={modalFooterStyle({
        class: className,
      })}
    />
  );
});

const ModalCloseButton = React.forwardRef<
  React.ComponentRef<typeof UIModal.CloseButton>,
  IModalCloseButtonProps
>(function ModalCloseButton({ className, ...props }, ref) {
  return (
    <UIModal.CloseButton
      ref={ref}
      {...props}
      className={modalCloseButtonStyle({
        class: className,
      })}
    />
  );
});

Modal.displayName = 'Modal';
ModalBackdrop.displayName = 'ModalBackdrop';
ModalContent.displayName = 'ModalContent';
ModalHeader.displayName = 'ModalHeader';
ModalBody.displayName = 'ModalBody';
ModalFooter.displayName = 'ModalFooter';
ModalCloseButton.displayName = 'ModalCloseButton';

export {
  Modal,
  ModalBackdrop, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader
};

