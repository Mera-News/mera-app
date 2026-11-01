import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import MeraLogo from '@/components/custom/MeraLogo';
import { ScrollView } from '@/components/ui/scroll-view';
import { Button, ButtonText } from '@/components/ui/button';
import { useColors } from '@/lib/theme/tokens';

import { PhoneUnsupported } from './parts';
import { LOGO_TOP, styles } from './styles';

// ── 4 · How do you want to begin? ────────────────────────────────────────────

function BeginStage({
    canUsePhone,
    onWithoutEmail,
    onLearn,
    onLogoSlot,
}: {
    canUsePhone: boolean;
    onWithoutEmail: () => void;
    /** Plays the welcome video. */
    onLearn: () => void;
    /** Where the logo belongs in this stack (window y), for the hoisted logo. */
    onLogoSlot: (slot: { y: number; inline: boolean }) => void;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    // One centred stack (owner): logo, title, the primary with its helper.
    // Taller than the screen (Larger Text): it scrolls, top-aligned,
    // and draws the logo inline, since the hoisted one cannot scroll with it.
    const [viewport, setViewport] = useState(0);
    const [content, setContent] = useState(0);
    const inline = viewport > 0 && content > viewport;
    const slotRef = useRef<React.ComponentRef<typeof View>>(null);
    const report = useCallback(() => {
        slotRef.current?.measureInWindow((_x, y) => onLogoSlot({ y, inline }));
    }, [inline, onLogoSlot]);
    useEffect(report, [report]);
    return (
        <ScrollView
            testID="auth-begin"
            onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
            onContentSizeChange={(_w, h) => setContent(h)}
            contentContainerStyle={[styles.beginStack, inline ? null : styles.beginCentered]}
        >
            <View ref={slotRef} onLayout={report} style={styles.beginLogo}>
                {inline ? <MeraLogo size={LOGO_TOP} animated /> : null}
            </View>
            <Text accessibilityRole="header" style={[styles.title, styles.centerText, styles.beginTitle, { color: colors.ink }]}>
                {t('auth.track.beginTitle')}
            </Text>
            {canUsePhone ? (
                <>
                    <Button action="primary" onPress={onWithoutEmail} style={styles.beginPrimary} testID="auth-begin-without-email">
                        <ButtonText>{t('auth.track.beginWithoutEmail')}</ButtonText>
                    </Button>
                    <Button variant="outline" action="secondary" onPress={onLearn} style={styles.beginLearn} testID="auth-learn-mera">
                        <ButtonText>{t('auth.learnAboutMera')}</ButtonText>
                    </Button>
                </>
            ) : (
                <PhoneUnsupported testID="auth-begin-unsupported" />
            )}
        </ScrollView>
    );
}

export { BeginStage };
