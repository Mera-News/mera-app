import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '2xs' | '5xl' | '6xl';

interface TranslatableStaticProps {
    /** i18n key, e.g. 'common.cancel' or 'feed.minutesAgo' */
    readonly i18nKey: string;
    /** Interpolation values, e.g. { count: 5 } */
    readonly values?: Record<string, unknown>;
    /** Render as <Heading> instead of <Text>. Defaults to 'text'. */
    readonly as?: 'text' | 'heading';
    readonly size?: TextSize;
    readonly className?: string;
    readonly style?: Record<string, unknown>;
    readonly numberOfLines?: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
}

/**
 * Drop-in replacement for <Text>/<Heading> that renders a static i18n string.
 *
 * Use this for all static UI strings (buttons, labels, settings text, etc.).
 * For dynamic server content that needs runtime ML translation, use <TranslatableDynamic>.
 */
const TranslatableStatic: React.FC<TranslatableStaticProps> = ({
    i18nKey,
    values,
    as = 'text',
    size = 'md',
    className,
    style,
    numberOfLines,
    bold,
    italic,
}) => {
    const { t } = useTranslation();
    // Cast needed because i18nKey is a runtime string, not a literal type
    const text = (t as any)(i18nKey, values);

    const sharedProps = { className, style, bold, italic } as const;

    if (as === 'heading') {
        return (
            <Heading size={size as any} numberOfLines={numberOfLines} {...sharedProps}>
                {text}
            </Heading>
        );
    }

    return (
        <Text size={size} numberOfLines={numberOfLines} {...sharedProps}>
            {text}
        </Text>
    );
};

export default TranslatableStatic;
