import React from 'react';
import { Platform } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

interface LanguageDownloadHintProps {
    /** Distinguishes the two render sites for tests and the sim harness. */
    readonly testID?: string;
    /** Per-site layout only (alignment, margins). Colour and size are fixed. */
    readonly className?: string;
}

/**
 * "Tap the ⊙↓ next to each language" — the one thing Apple's Required
 * Downloads sheet never says about itself.
 *
 * Picking a non-English language raises that sheet, and nothing downloads
 * until the user taps the circled down-arrow beside each row. Users who do
 * not know that simply wait, and our spinner waits with them.
 *
 * This exists as a component rather than as copied JSX because the same
 * sentence has to appear beside BOTH language selectors — Settings and the
 * pre-auth screen — and the icon is rendered inline, mid-sentence. Copying
 * that is how the two selectors drift apart, which is a mistake this feature
 * has already made once (see the shared `useLanguageSwitch`).
 *
 * iOS-only by construction: Android has no such sheet, so there is no
 * down-arrow to tap and the instruction would be a lie.
 *
 * The glyph is a font character from `@expo/vector-icons`, which is why it
 * can sit inside <Text> and share its baseline; an SVG icon pack cannot.
 * `arrow-down-circle-outline` is the closest match to Apple's own
 * `arrow.down.circle`.
 */
const LanguageDownloadHint: React.FC<LanguageDownloadHintProps> = ({
    testID = 'language-download-hint',
    className = '',
}) => {
    const { t } = useTranslation();

    if (Platform.OS !== 'ios') return null;

    return (
        <Text
            testID={testID}
            className={`text-typography-400 text-xs leading-5 ${className}`}
        >
            {t('language.downloadHintBeforePrefix')}{' '}
            <MaterialCommunityIcons
                name="arrow-down-circle-outline"
                size={14}
                color="#a78bfa"
            />
            {' '}{t('language.downloadHintBeforeSuffix')}
        </Text>
    );
};

export default LanguageDownloadHint;
