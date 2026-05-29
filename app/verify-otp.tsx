import DeepLinkVerifyScreen from '@/components/custom/auth/DeepLinkVerifyScreen';
import { useLocalSearchParams } from 'expo-router';

export default function VerifyOtpRoute() {
    const { otp, email, type } = useLocalSearchParams<{ otp: string; email: string; type: string }>();
    return <DeepLinkVerifyScreen otp={otp} email={email} type={type} />;
}
