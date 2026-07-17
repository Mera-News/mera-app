import i18next from 'i18next';
import { AccessibilityInfo } from 'react-native';
import type React from 'react';
import { getBellAnchor } from './notifications/bell-anchor';
import logger from './logger';

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

/** The subset of useToast()'s show() options this manager actually passes. */
export interface ToastShowOptions {
    placement?: 'top' | 'bottom' | 'top right' | 'top left' | 'bottom right' | 'bottom left';
    duration?: number;
    render: (props: { id: string }) => React.ReactNode;
}

type ToastFunction = {
    show: (options: ToastShowOptions) => string;
    close: (id: string) => void;
    closeAll: () => void;
    isActive: (id: string) => boolean;
};

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
    private resolveI18n(key: string): string {
        if (!key) return '';
        // Cast: i18next.t is strongly typed to known keys, but these may be
        // dynamic keys OR already-resolved freeform strings.
        const resolved = (i18next.t as unknown as (k: string) => string)(key);
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

        const message = customMessage || 'Unable to connect. Please check your internet connection.';

        // Import React for JSX
        const React = require('react');
        const { Toast, ToastTitle, ToastDescription } = require('@/components/ui/toast');

        this.toastInstance.show({
            placement: 'top',
            duration: 4000,
            render: ({ id }: { id: string }) => {
                return React.createElement(
                    Toast,
                    { action: 'error', variant: 'solid' },
                    React.createElement(ToastTitle, null, 'Network Error'),
                    React.createElement(ToastDescription, null, message)
                );
            },
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

        const React = require('react');
        const { Toast, ToastTitle, ToastDescription } = require('@/components/ui/toast');

        this.toastInstance.show({
            placement: 'top',
            duration: 4000,
            render: ({ id }: { id: string }) => {
                return React.createElement(
                    Toast,
                    { action: 'error', variant: 'solid' },
                    React.createElement(ToastTitle, null, title),
                    React.createElement(ToastDescription, null, message)
                );
            },
        });
    }

    /**
     * Show a success toast
     */
    showSuccess(title: string, message: string) {
        if (!this.toastInstance) {
            logger.warn('[ToastManager] Toast instance not initialized. Call setToastInstance() first.');
            return;
        }

        const React = require('react');
        const { Toast, ToastTitle, ToastDescription } = require('@/components/ui/toast');

        this.toastInstance.show({
            placement: 'top',
            duration: 3000,
            render: ({ id }: { id: string }) => {
                return React.createElement(
                    Toast,
                    { action: 'success', variant: 'solid' },
                    React.createElement(ToastTitle, null, title),
                    React.createElement(ToastDescription, null, message)
                );
            },
        });
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

        const React = require('react');
        const { Toast, ToastTitle, ToastDescription } = require('@/components/ui/toast');

        this.toastInstance.show({
            placement: 'bottom',
            duration: 1500,
            render: ({ id }: { id: string }) => {
                return React.createElement(
                    Toast,
                    { action: 'info', variant: 'solid' },
                    React.createElement(ToastTitle, null, title),
                    message ? React.createElement(ToastDescription, null, message) : null,
                );
            },
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
     * distinct event.
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
        const NotifiedToast = require('@/components/custom/notifications/NotifiedToast').default;

        const title = this.resolveI18n(opts.title);
        const body = this.resolveI18n(opts.body);
        const anchor = getBellAnchor();
        const reduceMotion = this.reduceMotion;

        this.toastInstance.show({
            placement: 'top',
            duration: 2000,
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
