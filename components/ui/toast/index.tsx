'use client';
import React from 'react';
import { toastApi } from '@/lib/toast/toast-queue';

/**
 * `useToast()` is APP-OWNED: `{ show, close, closeAll, isActive }` over the one
 * queue in `lib/toast/toast-queue.ts`, painted by
 * `components/custom/toast/ToastDeck.tsx`. It was gluestack's hook once, and
 * `GluestackUIProvider` mounts a `ToastProvider` at the root AND inside ~24
 * nested route files, so a screen's `useToast()` and `toastManager` drove two
 * different queues. Those nested providers are INERT now (nothing calls their
 * `setToast`) and stay mounted: every other gluestack overlay shares them.
 *
 * What a card looks like is `components/custom/toast/MeraToast.tsx`, the one
 * toast every caller renders.
 */
const useToast = () => toastApi;

/**
 * Whether the surrounding card is the FRONT of the deck, i.e. the one the user
 * can actually read. Provided by `ToastDeck`; `true` by default so a toast
 * rendered outside the deck (tests) behaves as the front.
 */
const ToastFrontContext = React.createContext(true);
export const ToastFrontProvider = ToastFrontContext.Provider;
export const useIsToastFront = () => React.useContext(ToastFrontContext);

export { useToast };
