import type React from 'react';
import logger from './logger';

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
     * Reset debounce timer (useful for testing)
     */
    resetDebounce() {
        this.lastErrorTime = 0;
    }
}

// Export singleton instance
export const toastManager = new ToastManager();
