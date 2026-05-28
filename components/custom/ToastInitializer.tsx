import { useToast } from '@/components/ui/toast';
import { toastManager } from '@/lib/toast-manager';
import { useEffect } from 'react';

/**
 * ToastInitializer Component
 *
 * Initializes the global toast manager with the toast instance from useToast()
 * This component should be placed early in the component tree (in _layout.tsx)
 * so that the toast manager is ready before any errors occur.
 *
 * This component has no visual output - it only performs initialization.
 */
export default function ToastInitializer() {
    const toast = useToast();

    useEffect(() => {
        // Initialize the toast manager with the toast instance
        toastManager.setToastInstance(toast);
    }, [toast]);

    // This component renders nothing - it only initializes the toast manager
    return null;
}
