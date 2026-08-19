import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import WelcomeBackScreen from '@/components/custom/auth/WelcomeBackScreen';

// Routing only (screens live in components/custom). Top-level like /login:
// this is a pre-shell moment, reached only from the device sign-in success
// handler when the trial-memory verdict says welcome back.
export default function WelcomeBack() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <WelcomeBackScreen />
        </ErrorBoundary>
    );
}
