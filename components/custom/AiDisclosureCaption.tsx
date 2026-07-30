import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export type AiDisclosureCaptionVariant = 'caption' | 'compact';

interface AiDisclosureCaptionProps {
    /**
     * 'caption' (default): a quiet one-line note meant to sit directly under a
     * reason box — sized/italicized like `TranslationNotice`'s calm,
     * non-alarming tone.
     *
     * 'compact': a tighter inline label for a tracked-story LLM headline row —
     * smaller, non-italic, meant to sit right under a heading without
     * competing with it.
     */
    variant?: AiDisclosureCaptionVariant;
    /**
     * Override the announced/displayed text. Defaults to the article
     * disclosure copy (`aiDisclosure.caption`). The chat thread-header notice
     * passes its own copy here — it discloses talking to an AI, not that the
     * displayed text is AI-generated, so it must not reuse this copy verbatim.
     */
    text?: string;
    className?: string;
}

/**
 * EU AI Act Art. 50 transparency caption for Mera-generated text.
 *
 * Unconditional by design (Group C1 decision): every AI-generated story
 * section gets the identical caption. There is no model-emitted risk flag,
 * confidence score, or other signal gating whether it renders — only whether
 * the surface actually has AI-generated text to disclose in the first place.
 *
 * Accessibility precedent: `RelevanceChip` — never convey meaning by colour
 * alone. The sparkle icon is decorative; the text alone carries the meaning,
 * and the row exposes a single composed `accessibilityLabel` so a screen
 * reader announces the full disclosure once rather than icon-then-text.
 */
const AiDisclosureCaption: React.FC<AiDisclosureCaptionProps> = ({
    variant = 'caption',
    text,
    className,
}) => {
    const { t } = useTranslation();
    const message = text ?? t('aiDisclosure.caption');
    const compact = variant === 'compact';

    return (
        <HStack
            className={`items-center${className ? ` ${className}` : ''}`}
            space="xs"
            accessible
            accessibilityLabel={message}
        >
            <MaterialIcons
                name="auto-awesome"
                size={compact ? 11 : 13}
                color="rgb(148, 148, 148)"
            />
            <Text
                size={compact ? '2xs' : 'xs'}
                italic={!compact}
                className="text-typography-500 flex-1"
            >
                {message}
            </Text>
        </HStack>
    );
};

export default AiDisclosureCaption;
