import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { authClient } from "@/lib/auth-client";
import { Redirect } from "expo-router";

export default function Index() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <Box className="flex-1 justify-center items-center bg-background-0">
        <MeraLogo size={96} />
      </Box>
    );
  }

  // If user is authenticated, redirect to logged-in index (which handles routing logic)
  if (session) {
    return <Redirect href="/logged-in" />;
  }

  // No session — redirect to login
  return <Redirect href="/login" />;
}
