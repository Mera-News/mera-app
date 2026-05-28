import MeraLogo from "@/components/custom/MeraLogo";
import { Box } from "@/components/ui/box";
import { Button, ButtonText } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { VStack } from "@/components/ui/vstack";
import { AccountService } from "@/lib/account-service";
import { authClient } from "@/lib/auth-client";
import { SUPPORT_EMAIL } from "@/lib/config/branding";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function NotSubscribedScreen() {
    const { data: session, isPending: isSessionPending } = authClient.useSession();
    const router = useRouter();
    const [isCheckingApproval, setIsCheckingApproval] = useState(false);
    const { t } = useTranslation();

    const handleRefresh = async () => {
        if (!session?.user?.id) {
            return;
        }

        setIsCheckingApproval(true);

        try {
            // Try to fetch user persona - if successful, user is approved
            await AccountService.getUserPersona(session.user.id);

            // If we reach here, user is approved - redirect to logged-in
            router.replace('/logged-in');
        } catch (error: any) {
            // Check if error is subscription-related
            const statusCode = error?.networkError?.statusCode;
            const errorMessage = error?.message || '';
            const errorExtensions = error?.graphQLErrors?.[0]?.extensions;

            const isSubscriptionError =
                statusCode === 402 ||
                errorMessage.includes('NotSubscribedException') ||
                errorExtensions?.code === 'NOT_SUBSCRIBED' ||
                errorExtensions?.exception?.name === 'NotSubscribedException';

            if (isSubscriptionError) {
                // User is still not approved - stay on this screen
                setIsCheckingApproval(false);
            } else {
                // Some other error occurred - stay on screen but stop checking
                setIsCheckingApproval(false);
            }
        }
    };

    // Show loading screen while checking session
    if (isSessionPending) {
        return (
            <Box className="flex-1 justify-center items-center bg-black">
                <Spinner size="large" />
            </Box>
        );
    }

    // Show subscription pending message
    return (
        <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
            <Box className="flex-1 justify-center items-center bg-black px-6">
                <VStack space="xl" className="items-center max-w-md">
                    {/* Logo */}
                    <Box className="items-center mb-8">
                        <MeraLogo size={150} />
                    </Box>
                    <Heading size="2xl" className="text-white text-center">
                        {t('account.pendingTitle')}
                    </Heading>

                    <Text size="lg" className="text-gray-300 text-center leading-relaxed">
                        {t('account.pendingDescription')}
                    </Text>

                    <Text size="md" className="text-gray-400 text-center mt-4">
                        {t('account.enquiries')}{" "}
                        <TouchableOpacity onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
                            <Text size="md" className="text-primary-400">
                                {t('account.contactEmail', { supportEmail: SUPPORT_EMAIL })}
                            </Text>
                        </TouchableOpacity>
                    </Text>

                    <Box className="items-center w-full mt-8">
                        <Button
                            onPress={handleRefresh}
                            disabled={isCheckingApproval}
                            variant="outline"
                            className="border-primary-500"
                            size="lg"
                        >
                            {isCheckingApproval ? (
                                <Spinner size="small" className="mr-2" />
                            ) : null}
                            <ButtonText className="text-white">
                                {isCheckingApproval ? t('common.checking') : t('account.refresh')}
                            </ButtonText>
                        </Button>
                    </Box>
                </VStack>
            </Box>
        </SafeAreaView>
    );
}
