// S6's section of the navx2 P2 kit gallery (app/dev-kit.tsx): the shared kit
// in every state. Dev only, English literals on purpose; deleted in P13.
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ConsentContent from '@/components/custom/auth/ConsentContent';
import { consentNoticeKey } from '@/components/custom/auth/device-sign-in-copy';
import { LanguageRow } from '@/components/custom/auth/LanguageRow';
import { OtpBoxes, type OtpState } from '@/components/custom/auth/OtpBoxes';
import ModalMaterial from '@/components/custom/ModalMaterial';
import { NextGuardBox } from '@/components/custom/onboarding/NextGuardBox';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button, ButtonText } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PressScale } from '@/components/ui/pressable/press-scale';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Shimmer, ShimmerText } from '@/components/ui/shimmer';
import { StepsAccordion, type StepStatus } from '@/components/ui/steps-accordion';
import { showDialog } from '@/lib/dialog';
import { hapticError, hapticLight, hapticMedium, hapticSelection, hapticSuccess } from '@/lib/haptics';
import { useColors } from '@/lib/theme/tokens';
import { toastApi } from '@/lib/toast/toast-queue';
import { Toast, ToastDescription, ToastTitle } from '@/components/ui/toast';

function Label({ children }: { children: string }) {
    const colors = useColors();
    return <Text style={{ color: colors.ink2, fontSize: 13, marginTop: 20, marginBottom: 8 }}>{children}</Text>;
}

function Small({ title, onPress }: { title: string; onPress: () => void }) {
    return (
        <Button size="sm" variant="outline" action="secondary" onPress={onPress} className="mr-2 mb-2">
            <ButtonText>{title}</ButtonText>
        </Button>
    );
}

export default function KitGallery() {
    const { t } = useTranslation();
    const colors = useColors();
    const [sheet, setSheet] = useState(false);
    const [dialog, setDialog] = useState<'none' | 'confirm' | 'destructive' | 'info' | 'busy'>('none');
    const [appearance, setAppearance] = useState<'light' | 'dark'>('dark');
    const [three, setThree] = useState<'a' | 'b' | 'c'>('a');
    const [step, setStep] = useState(0);
    const [otp, setOtp] = useState('');
    const [otpState, setOtpState] = useState<OtpState>('idle');
    const [guard, setGuard] = useState(false);
    const [picked, setPicked] = useState('en');

    const statusOf = (i: number): StepStatus => (i < step ? 'done' : i === step ? 'open' : 'hidden');

    return (
        <View>
            <Label>ModalMaterial (sheet and dialog surface)</Label>
            <View style={[styles.swatch, { borderColor: colors.line }]}>
                <ModalMaterial />
                <Text style={{ color: colors.ink, padding: 16 }}>Glow: orange top left, violet right, blue bottom</Text>
            </View>

            <Label>BottomSheet</Label>
            <Small title="Open sheet" onPress={() => setSheet(true)} />
            <BottomSheet open={sheet} onClose={() => setSheet(false)} testID="kit-sheet">
                <View style={{ padding: 20, gap: 8 }}>
                    <Text style={{ color: colors.ink, fontSize: 17, fontWeight: '700' }}>A bottom sheet</Text>
                    <Text style={{ color: colors.ink2 }}>Drag down, tap the dim, or press Back to close.</Text>
                </View>
            </BottomSheet>

            <Label>ConfirmDialog and showDialog</Label>
            <View style={styles.wrap}>
                <Small title="Confirm" onPress={() => setDialog('confirm')} />
                <Small title="Destructive" onPress={() => setDialog('destructive')} />
                <Small title="Notice (one button)" onPress={() => setDialog('info')} />
                <Small title="Busy" onPress={() => setDialog('busy')} />
                <Small
                    title="showDialog x2 (queued)"
                    onPress={() => {
                        void showDialog({ title: 'First', body: 'Queued dialogs show one at a time.', confirmLabel: 'Next', cancelLabel: 'Cancel' });
                        void showDialog({ title: 'Second', confirmLabel: 'OK' });
                    }}
                />
            </View>
            <ConfirmDialog
                open={dialog === 'confirm'}
                title="Turn off backup?"
                body="Mera forgets the recovery code on this phone."
                confirmLabel="Turn off"
                onConfirm={() => setDialog('none')}
                onCancel={() => setDialog('none')}
            />
            <ConfirmDialog
                open={dialog === 'destructive'}
                title="Delete Fact"
                body="Are you sure you want to delete this fact?"
                warning="Its topics and the stories they found go too, and Mera stops looking for news about it."
                confirmLabel="Yes, Delete"
                destructive
                onConfirm={() => setDialog('none')}
                onCancel={() => setDialog('none')}
            />
            <ConfirmDialog
                open={dialog === 'info'}
                title="Couldn't switch to Dutch"
                body="You're still reading Mera in English."
                confirmLabel="OK"
                onConfirm={() => setDialog('none')}
            />
            <ConfirmDialog
                open={dialog === 'busy'}
                title="Deleting your account"
                confirmLabel="Deleting"
                destructive
                busy
                onConfirm={() => setDialog('none')}
                onCancel={() => setDialog('none')}
            />

            <Label>Shimmer and ShimmerText</Label>
            <View style={{ gap: 8 }}>
                <Shimmer height={18} width="70%" />
                <Shimmer height={64} radius={12} />
                <ShimmerText style={{ fontSize: 16, fontWeight: '700' }}>Updating your feed</ShimmerText>
            </View>

            <Label>SegmentedControl (Appearance, and three options)</Label>
            <View style={{ gap: 12 }}>
                <SegmentedControl
                    accessibilityLabel="Appearance"
                    value={appearance}
                    onChange={setAppearance}
                    options={[
                        { value: 'light', label: 'Light', icon: 'light-mode' },
                        { value: 'dark', label: 'Dark', icon: 'dark-mode' },
                    ]}
                    testID="kit-appearance"
                />
                <SegmentedControl
                    accessibilityLabel="Three"
                    value={three}
                    onChange={setThree}
                    options={[
                        { value: 'a', label: 'Small' },
                        { value: 'b', label: 'Default' },
                        { value: 'c', label: 'Large' },
                    ]}
                />
            </View>

            <Label>StepsAccordion (tap Next step, Change reopens)</Label>
            <StepsAccordion
                testID="kit-steps"
                steps={[
                    { id: 'code', title: 'Recovery code', hint: 'Write it down.', summary: 'Saved', actionLabel: 'Show', onAction: () => setStep(0) },
                    { id: 'where', title: 'Where to keep it', hint: 'The copy is encrypted either way.', summary: 'iCloud', actionLabel: 'Change', onAction: () => setStep(1) },
                    { id: 'often', title: 'How often', hint: 'Picking one finishes setup.', summary: 'Every day', actionLabel: 'Change', onAction: () => setStep(2) },
                ].map((s, i) => ({
                    ...s,
                    status: statusOf(i),
                    children: <Small title={i === 2 ? 'Finish setup' : 'Next step'} onPress={() => setStep(i + 1)} />,
                }))}
            />
            <Small title="Reset steps" onPress={() => setStep(0)} />

            <Label>PressScale</Label>
            <PressScale style={[styles.pressCard, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <Text style={{ color: colors.ink }}>Press and hold me</Text>
            </PressScale>

            <Label>OtpBoxes (type 6 digits: 123456 is right)</Label>
            <OtpBoxes
                value={otp}
                state={otpState}
                a11yLabel="6-digit code"
                onChange={(v) => {
                    setOtp(v);
                    if (otpState !== 'idle') setOtpState('idle');
                }}
                onComplete={(code) => setOtpState(code === '123456' ? 'right' : 'wrong')}
                testID="kit-otp"
            />
            <Small title="Clear code" onPress={() => { setOtp(''); setOtpState('idle'); }} />

            <Label>NextGuardBox</Label>
            <View style={{ alignItems: 'flex-end', gap: 8 }}>
                <NextGuardBox
                    open={guard}
                    title="Continue without any facts?"
                    body="Mera picks your news from your facts. Without any, your Feed shows only top headlines, and World shows no countries until you add them."
                    primaryLabel="Add a fact"
                    onPrimary={() => setGuard(false)}
                    secondaryLabel="Continue anyway"
                    onSecondary={() => setGuard(false)}
                    style={{ width: '100%' }}
                />
                <Small title="Next" onPress={() => setGuard(true)} />
            </View>

            <Label>Before you start, device path (FinalJourney #7; static, never signs in)</Label>
            <View style={styles.consent}>
                <AbstractGradientBackdrop />
                <View style={{ padding: 20 }}>
                    <ConsentContent
                        testIDPrefix="kit-consent"
                        title={t('auth.track.beforeYouStart')}
                        body={t('consent.welcomeBody')}
                        notice={
                            <Text style={{ color: colors.ink2, fontSize: 15, lineHeight: 21 }}>
                                {t(consentNoticeKey('app-attest') ?? 'consent.deviceNotice.generic')}
                            </Text>
                        }
                        onWhatMeraKeeps={() => undefined}
                        ctaLabel={t('consent.accept')}
                        onAccept={() => undefined}
                    />
                </View>
            </View>

            <Label>LanguageRow (picked, download, busy, plain)</Label>
            <View style={[styles.list, { backgroundColor: colors.surface, borderColor: colors.line }]}>
                <LanguageRow endonym="English" english="English" isPhoneLanguage picked={picked === 'en'} accessory="none" onPress={() => setPicked('en')} downloadA11yLabel="Download English" phoneLanguageLabel="Your phone's language" />
                <LanguageRow endonym="Nederlands" english="Dutch" isPhoneLanguage={false} picked={picked === 'nl'} accessory="download" onPress={() => setPicked('nl')} onDownload={() => setPicked('nl')} downloadA11yLabel="Download Dutch" phoneLanguageLabel="Your phone's language" />
                <LanguageRow endonym="Español" english="Spanish" isPhoneLanguage={false} picked={picked === 'es'} accessory="busy" onPress={() => setPicked('es')} downloadA11yLabel="Download Spanish" phoneLanguageLabel="Your phone's language" />
                <LanguageRow endonym="हिन्दी" english="Hindi" isPhoneLanguage={false} picked={picked === 'hi'} accessory="none" onPress={() => setPicked('hi')} downloadA11yLabel="Download Hindi" phoneLanguageLabel="Your phone's language" />
            </View>

            <Label>Toasts (notice panel, a never-expiring one, close all)</Label>
            <View style={styles.wrap}>
                <Small
                    title="Notice 4 s"
                    onPress={() =>
                        toastApi.show({
                            duration: 4000,
                            render: () => (
                                <Toast action="muted">
                                    <ToastTitle>Tidy up your profile</ToastTitle>
                                    <ToastDescription>Two facts say almost the same thing.</ToastDescription>
                                </Toast>
                            ),
                        })
                    }
                />
                <Small
                    title="Stays (duration null)"
                    onPress={() =>
                        toastApi.show({
                            duration: null,
                            render: () => (
                                <Toast action="muted">
                                    <ToastTitle>Stays until closed</ToastTitle>
                                </Toast>
                            ),
                        })
                    }
                />
                <Small title="Close all" onPress={() => toastApi.closeAll()} />
            </View>

            <Label>Haptics</Label>
            <View style={styles.wrap}>
                <Small title="Light" onPress={() => void hapticLight()} />
                <Small title="Medium" onPress={() => void hapticMedium()} />
                <Small title="Selection" onPress={() => void hapticSelection()} />
                <Small title="Success" onPress={() => void hapticSuccess()} />
                <Small title="Error" onPress={() => void hapticError()} />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    consent: { borderRadius: 24, overflow: 'hidden' },
    swatch: { height: 200, borderRadius: 24, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
    wrap: { flexDirection: 'row', flexWrap: 'wrap' },
    pressCard: { padding: 20, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth },
    list: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 4 },
});
