import i18next from 'i18next';
import { AccessibilityInfo } from 'react-native';
import type React from 'react';
import { getBellAnchor } from './notifications/bell-anchor';
import logger from './logger';
import { TOAST_MIN_DURATION_MS } from './toast/toast-queue';
import { TOAST_BODY_COLOR, TOAST_TITLE_COLOR } from '@/components/custom/toast/toast-text';

// The readable floor for any toast's lifetime lives with the queue.
// Re-exported so this module stays its public home.
export { TOAST_MIN_DURATION_MS };

/** Options for a notification-center-backed toast (see showNotifiedToast). */
export interface NotifiedToastOptions {
    type: string;
    source: string;
    title: string;
    body: string;
    action?: 'info' | 'success' | 'error';
    icon?: string;
    context?: Record<string, unknown>;
    actions?: { id: string; labelKey?: string; label?: string }[];
    /**
     * Opt-in — plumbed straight through to `notify()`'s `dedupeDaily`.
     * Suppresses the persisted notification-center row (not this transient
     * toast) when one with the same `(type, source)` was already created
     * today (UTC). Leave unset for callers where a same-day repeat is a
     * genuinely distinct event (default `false`, unchanged behaviour).
     */
    dedupeDaily?: boolean;
}

/**
 * Global Toast Manager Service
 *
 * Provides a way to show toast notifications from non-React contexts
 * (like Apollo Client error links, utility functions, etc.)
 *
 * Usage:
 * 1. Initialize with toast instance from a React component using useToast()
 * 2. Call toastManager.showNetworkError() or toastManager.showError() from anywhere
 */

/**
 * The subset of useToast()'s show() options this manager actually passes.
 * No `placement`: the top deck is the app's ONLY toast mechanism, so every
 * method here joins the one stack behind whatever card is already showing.
 */
export interface ToastShowOptions {
    duration?: number;
    render: (props: { id: string }) => React.ReactNode;
}

type ToastFunction = {
    show: (options: ToastShowOptions) => string;
    close: (id: string) => void;
    closeAll: () => void;
    isActive: (id: string) => boolean;
};

// Toast text colours: see components/custom/toast/toast-text.ts.

class ToastManager {
    private toastInstance: ToastFunction | null = null;
    private lastErrorTime = 0;
    private readonly DEBOUNCE_DURATION = 5000; // 5 seconds
    // Cached OS reduce-motion flag — read imperatively (this is a non-React
    // singleton, no hooks). Kicked off in the constructor and refreshed lazily
    // on each notified toast so it tracks the setting without a subscription.
    private reduceMotion = false;

    constructor() {
        this.refreshReduceMotion();
    }

    private refreshReduceMotion(): void {
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                this.reduceMotion = enabled;
            })
            .catch(() => {
                /* default: motion enabled */
            });
    }

    /** i18n key → resolved string; falls back to the raw string on a miss. */
    private resolveI18n(key: string, values?: Record<string, unknown> | null): string {
        if (!key) return '';
        // Cast: i18next.t is strongly typed to known keys, but these may be
        // dynamic keys OR already-resolved freeform strings. `values` fills the
        // key's {{placeholders}}: without them the reader saw the braces.
        const resolved = (i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string)(
            key,
            values ?? undefined,
        );
        return typeof resolved === 'string' && resolved.length > 0 ? resolved : key;
    }

    /**
     * Initialize the toast manager with a toast instance from useToast()
     * This should be called early in the app lifecycle from a React component
     */
    setToastInstance(toast: ToastFunction) {
        this.toastInstance = toast;
    }

    /**
     * Check if enough time has passed since the last error toast
     * Prevents toast spam when multiple requests fail simultaneously
     */
    private shouldShowToast(): boolean {
        const now = Date.now();
        if (now - this.lastErrorTime < this.DEBOUNCE_DURATION) {
            return false;
        }
        this.lastErrorTime = now;
        return true;
    }

    /**
     * Show a network error toast with a user-friendly message
     * Automatically debounced to prevent spam
     */
    showNetworkError(customMessage?: string) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        if (!this.shouldShowToast()) {
            logger.info('[ToastManager] Skipping duplicate error toast (debounced)');
            return;
        }

        const message = customMessage || i18next.t('errors.networkErrorBody');
        this.showPlainToast('error', i18next.t('errors.networkErrorTitle'), message, 4000);
    }

    /**
     * Shared renderer for the simple title+body toasts. Plain RN `Text` with
     * explicit styles, NOT ToastTitle/ToastDescription — see the note on
     * TOAST_TITLE_COLOR above (createElement bypasses className styling).
     */
    private showPlainToast(
        action: 'error' | 'success' | 'info',
        title: string,
        message: string | undefined,
        duration: number,
    ) {
        const React = require('react');
        const { Toast } = require('@/components/ui/toast');
        const { Text } = require('react-native');

        this.toastInstance!.show({
            duration,
            render: () =>
                React.createElement(
                    Toast,
                    { action, variant: 'solid' },
                    React.createElement(
                        Text,
                        { style: { color: TOAST_TITLE_COLOR, fontWeight: '700', fontSize: 15 } },
                        title,
                    ),
                    message
                        ? React.createElement(
                              Text,
                              { style: { color: TOAST_BODY_COLOR, fontSize: 13, paddingTop: 2 } },
                              message,
                          )
                        : null,
                ),
        });
    }

    /**
     * Show a generic error toast
     * Automatically debounced to prevent spam
     */
    showError(title: string, message: string) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        if (!this.shouldShowToast()) {
            logger.info('[ToastManager] Skipping duplicate error toast (debounced)');
            return;
        }

        this.showPlainToast('error', title, message, 4000);
    }

    /**
     * Show a success toast
     */
    showSuccess(title: string, message: string) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        this.showPlainToast('success', title, message, 3000);
    }

    /**
     * Show a neutral informational toast (e.g. a tab-name hint on long-press).
     * Not debounced — these are short-lived, low-frequency UI hints, not error
     * spam. `message` is optional since some hints are label-only.
     */
    showInfo(title: string, message?: string) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        this.showPlainToast('info', title, message, TOAST_MIN_DURATION_MS);
    }

    /**
     * THE undo toast: every "done, with Undo" confirmation goes through here so
     * they all look the same (`components/custom/toast/UndoToast.tsx`, the
     * green check card). The feedback leaf uses it after applying persona
     * mutations; the ••• menu's "Fewer from <source>" should too. Lives here so
     * the caller need not be a React component, and so the toast modules are
     * `require`d only when a toast is actually shown.
     *
     * Undo closes this card; `undoneTitle`, when given, follows with a short
     * info toast. `onUndo` may return (or resolve to) `false` to say the undo
     * was REFUSED (a newer change owns the value): then no follow-up shows,
     * since "Change undone" would be a false claim. `true` or nothing shows it.
     * Not debounced: each applied change is a distinct event.
     */
    showUndoToast(opts: {
        title: string;
        body?: string;
        undoLabel: string;
        undoneTitle?: string;
        /** Defaults to `feedback-undo`, the id the harness runbooks address. */
        undoTestID?: string;
        onUndo: () => void | boolean | Promise<void | boolean>;
    }) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        const React = require('react');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const UndoToast = require('@/components/custom/toast/UndoToast').default;

        this.toastInstance.show({
            duration: 6000,
            render: ({ id }: { id: string }) =>
                React.createElement(UndoToast, {
                    title: opts.title,
                    body: opts.body,
                    undoLabel: opts.undoLabel,
                    undoTestID: opts.undoTestID ?? 'feedback-undo',
                    onUndo: () => {
                        this.toastInstance?.close(id);
                        void (async () => {
                            let done: void | boolean = undefined;
                            try {
                                done = await opts.onUndo();
                            } catch (err) {
                                logger.captureException(err, {
                                    tags: { component: 'ToastManager', method: 'showUndoToast.undo' },
                                });
                            }
                            if (opts.undoneTitle && done !== false) this.showInfo(opts.undoneTitle);
                        })();
                    },
                }),
        });
    }

    /**
     * Notification-center-backed toast. First writes a persistent notification
     * row (so the bell badge increments via the reactive observeUnreadCount),
     * then shows a transient toast that flies toward the bell.
     *
     * The RAW i18n key strings are stored in the notification row so the panel
     * re-resolves them with the current locale; the toast itself resolves them
     * now (via i18next.t) for immediate display. NOT debounced — each call is a
     * distinct event, and this transient toast always renders regardless of
     * `opts.dedupeDaily`.
     *
     * `opts.dedupeDaily` (opt-in, default off) only gates step 1 — the
     * persisted notification-center row — via `notify()`'s same-day
     * `(type, source)` dedupe. It exists for callers whose upstream trigger
     * can retrigger the SAME event repeatedly in one day (e.g. a 60s
     * scheduler re-arm), not for callers where a same-day repeat is a
     * genuinely distinct event.
     */
    async showNotifiedToast(opts: NotifiedToastOptions) {
        // 1. Persist the row (raw keys). Dynamic import avoids a load-time cycle
        // (notification-service → database → …). Failure is non-fatal.
        try {
            const { notify } = await import('@/lib/database/services/notification-service');
            await notify({
                type: opts.type,
                title: opts.title,
                body: opts.body,
                icon: opts.icon ?? null,
                context: opts.context ?? null,
                actions: opts.actions ?? null,
                source: opts.source,
                dedupeDaily: opts.dedupeDaily,
            });
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'ToastManager', method: 'showNotifiedToast.notify' },
            });
        }

        // 2. Show the transient toast.
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }
        this.refreshReduceMotion(); // keep the cached flag fresh for next time

        const React = require('react');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const notifiedToastModule = require('@/components/custom/notifications/NotifiedToast');
        const NotifiedToast = notifiedToastModule.default;

        // The row keeps the raw keys plus `context`, and the notification
        // centre interpolates from that same context; the toast must too, or
        // 'No published fact checks yet for "{{title}}".' shows its braces.
        const title = this.resolveI18n(opts.title, opts.context);
        const body = this.resolveI18n(opts.body, opts.context);
        const anchor = getBellAnchor();
        const reduceMotion = this.reduceMotion;
        // Whether the toast will fly to the bell or just fade — the two legs
        // have different lengths, and the component derives the same flag.
        const canFly = !reduceMotion && anchor != null;

        this.toastInstance.show({
            // Match the toast's lifetime to the animation EXACTLY. NotifiedToast
            // holds fully opaque (so it can be READ) and only then leaves. Too
            // short and it is torn off mid-flight; too long and an invisible
            // toast stays mounted over the UI after the animation has finished.
            duration: notifiedToastModule.notifiedToastDurationMs(canFly),
            render: () =>
                React.createElement(NotifiedToast, {
                    title,
                    body,
                    action: opts.action ?? 'info',
                    reduceMotion,
                    anchor,
                }),
        });
    }

    /**
     * Reset debounce timer (useful for testing)
     */
    resetDebounce() {
        this.lastErrorTime = 0;
    }
}

// Export singleton instance
export const toastManager = new ToastManager();
