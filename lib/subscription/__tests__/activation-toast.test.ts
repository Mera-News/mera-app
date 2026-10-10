// activation-toast.test.ts — the announcement must name the real plan, or say
// nothing at all.
//
// `planName` falls through to `subscription.planPromo` for anything it does not
// recognise, and two live callers can arrive with no usable tier (a
// `syncEntitlement` whose fetch failed writes nothing, and the late polls pass
// `later.billing?.subscriptionTier`). "Promo is active" after a real purchase is
// worse than silence.

const mockShowSuccess = jest.fn();
jest.mock('@/lib/toast-manager', () => ({
    toastManager: { showSuccess: (...a: any[]) => mockShowSuccess(...a) },
}));

jest.mock('i18next', () => ({
    __esModule: true,
    default: {
        // Echo the key plus any interpolation, so assertions read the mapping.
        t: (k: string, o?: Record<string, unknown>) =>
            o ? `${k}:${JSON.stringify(o)}` : k,
    },
}));

import { showSubscriptionActivatedToast } from '../activation-toast';

beforeEach(() => jest.clearAllMocks());

describe('showSubscriptionActivatedToast', () => {
    it.each([
        ['starter', 'subscription.planStarter'],
        ['individual', 'subscription.planIndividual'],
        ['professional', 'subscription.planProfessional'],
    ])('announces a confirmed %s purchase', (tier, planKey) => {
        showSubscriptionActivatedToast(tier);
        expect(mockShowSuccess).toHaveBeenCalledWith(
            `subscription.activatedTitle:{"plan":"${planKey}"}`,
            'subscription.activatedBody',
        );
    });

    it.each([[null], [undefined], ['none']])(
        'stays silent when the new tier is %s',
        (tier) => {
            showSubscriptionActivatedToast(tier as string | null | undefined);
            expect(mockShowSuccess).not.toHaveBeenCalled();
        },
    );

    // (b): planName used to fall through to `subscription.planPromo`, turning an
    // unrecognised value into a confident, wrong plan name. It must be silence.
    it.each([['promo'], ['PROMOTIONAL'], ['mera-news-starter-plan'], ['']])(
        'stays silent for the unmappable tier %p rather than inventing "Promo"',
        (tier) => {
            showSubscriptionActivatedToast(tier);
            expect(mockShowSuccess).not.toHaveBeenCalled();
        },
    );
});
