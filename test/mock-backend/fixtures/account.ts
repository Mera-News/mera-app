// The one account the mock backend knows. Also hardcoded in scripts/e2e-android.sh:
// change both together.
export const FIXTURE_ACCOUNT = {
    email: 'e2e-fixture@example.com',
    otp: '424242',
    userId: '66e2e0000000000000000001',
    name: 'E2E Fixture',
} as const;
