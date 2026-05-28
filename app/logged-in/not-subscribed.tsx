import NotSubscribedScreen from "@/components/custom/auth/NotSubscribedScreen";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { Redirect } from "expo-router";

export default function NotSubscribed() {
    const { data: session, isPending } = authClient.useSession();

    // Show loading screen while checking auth state
    if (isPending) {
        return (
            <Box className="flex-1 justify-center items-center bg-black">
                <Spinner size="large" />
            </Box>
        );
    }

    // If no session, redirect to login
    if (!session) {
        return <Redirect href="/login" />;
    }

    // Render the screen component with auto-check logic
    return <NotSubscribedScreen />;
}
