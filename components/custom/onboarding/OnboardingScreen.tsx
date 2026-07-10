import OnboardingWizard from "@/components/custom/onboarding/OnboardingWizard";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { AccountService } from "@/lib/account-service";
import { OnboardingStage } from "@/lib/generated/graphql-types";
import { useEffect, useState } from "react";

interface OnboardingScreenProps {
    userId: string;
    onLoginRedirect: () => void;
    onComplete: () => void;
}

const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ userId, onComplete }) => {
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true);

    useEffect(() => {
        const checkOnboardingStatus = async () => {
            try {
                const stage = await AccountService.getOnboardingStage(userId);
                const needsOnboarding = stage !== OnboardingStage.Finished;
                setShowOnboarding(needsOnboarding);

                if (!needsOnboarding) {
                    onComplete();
                }
            } catch {
                // On error, assume onboarding is needed (safer than skipping it).
                setShowOnboarding(true);
            } finally {
                setIsCheckingOnboarding(false);
            }
        };

        checkOnboardingStatus();
    }, [userId, onComplete]);

    const handleOnboardingComplete = () => {
        setShowOnboarding(false);
        onComplete();
    };

    if (isCheckingOnboarding) {
        return (
            <Box className="flex-1 justify-center items-center bg-background-0">
                <Spinner size="large" />
            </Box>
        );
    }

    if (showOnboarding) {
        return <OnboardingWizard onComplete={handleOnboardingComplete} />;
    }

    return null;
};

export default OnboardingScreen;
