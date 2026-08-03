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
     * Icon + text colour. Defaults to the muted typography token, which reads
     * on the dark card background. Inside the reason box pass a lighter value
     * — that box hardcodes `#374151` (see `reasonBoxColors`), and the default
     * muted grey does not clear 4.5:1 against it. `#D1D5DB` measures 7.0:1.
     */
    color?: string;
    /**
     * Override the announced/displayed text. Defaults to the article
     * disclosure copy (`aiDisclosure.caption`). The chat thread-header notice
     * passes its own copy here — it discloses talking to an AI, not that the
     * displayed text is AI-generated, so it must not reuse this copy verbatim.
     */
    text?: string;
    /**
     * Which edge the row (and its text) hugs. Defaults to 'right' — the
     * historical behaviour, kept byte-identical for the consumers that sit under
     * a right-aligned block (tracked stories, story timeline, chat thread).
     *
     * The reason boxes pass 'left': the caption moved out from under the
     * right-aligned reason text and now sits directly beneath the priority chip
     * in the box's LEFT column, where a right-hugging row would read as
     * detached from the chip it labels.
     */
    align?: 'left' | 'right';
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
const DEFAULT_COLOR = 'rgb(148, 148, 148)';

const AiDisclosureCaption: React.FC<AiDisclosureCaptionProps> = ({
    variant = 'caption',
    text,
    color = DEFAULT_COLOR,
    align = 'right',
    className,
}) => {
    const { t } = useTranslation();
    const message = text ?? t('aiDisclosure.caption');
    const compact = variant === 'compact';
    const left = align === 'left';

    return (
        <HStack
            // No `flex-1` on the Text either way: the row hugs its content and
            // sits flush against the chosen edge — flush right under a
            // right-aligned reason, flush left under the priority chip.
            className={`items-center ${left ? 'justify-start' : 'justify-end'}${className ? ` ${className}` : ''}`}
            space="xs"
            accessible
            accessibilityLabel={message}
        >
            <MaterialIcons
                name="auto-awesome"
                size={compact ? 11 : 13}
                color={color}
            />
            <Text
                size={compact ? '2xs' : 'xs'}
                italic={!compact}
                className={left ? 'text-left' : 'text-right'}
                style={{ color }}
            >
                {message}
            </Text>
        </HStack>
    );
};

export default AiDisclosureCaption;
