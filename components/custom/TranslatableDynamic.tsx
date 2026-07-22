import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { translateText } from '@/lib/translation-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { subscribeScrollTick } from '@/lib/visibility-tick';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dimensions, View } from 'react-native';

type MeasurableNode = {
    measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
    ) => void;
};

type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '2xs' | '5xl' | '6xl';

interface TranslatableProps {
    /** Translatable source. Assumed to be English. */
    readonly text: string;
    /**
     * Original-language version (DB-stored). Shown when:
     *  - the per-card "Show original" toggle (see `showToggle`) is on, or
     *  - the original language already matches the user's app language, or
     *  - a translation is still pending (so users see readable content
     *    immediately instead of English flashing through).
     * Falls back to `text` when not provided (e.g. LLM-generated strings
     * that only exist in English).
     */
    readonly originalText?: string;
    /** BCP-47-ish code of `originalText`'s language (e.g. `hi`, `pt`). When
     *  provided and it matches the current app language, no translation runs. */
    readonly originalLanguage?: string | null;
    /** Render as `<Heading>` instead of `<Text>`. */
    readonly as?: 'text' | 'heading';
    readonly size?: TextSize;
    readonly className?: string;
    readonly style?: Record<string, unknown>;
    readonly numberOfLines?: number;
    readonly bold?: boolean;
    readonly italic?: boolean;
    /**
     * When true, replaces the inline translate icon with a tappable rounded
     * button that lets the user toggle between translated and original text
     * for this instance only (local state, not persisted). Intended for the
     * screen (detail) variant where there is space for it.
     */
    readonly showToggle?: boolean;
    /**
     * Fired (in an effect, never during render) whenever the effective
     * displayed text changes — covers the Show original/Show translation toggle
     * and async translation resolution. Lets a parent (e.g. the detail screen's
     * share sheet) mirror the exact title variant the user is looking at.
     */
    readonly onDisplayChange?: (state: { showingOriginal: boolean; displayedText: string }) => void;
}

/** Loose match so `hi-IN` ≈ `hi`, `zh-Hans` ≈ `zh-CN`, etc. */
function languagesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}

/** Buffer (in px) around the viewport used to pre-translate items that are
 *  just off-screen, so they don't flash untranslated when scrolled in. */
const VISIBILITY_BUFFER_PX = 200;

/** Both our server-side translator (NLLB-200) and iOS's on-device
 *  translator occasionally emit literal `<unk>` tokens for glyphs they
 *  couldn't map. Strip them and collapse the whitespace they leave behind. */
function stripUnkTokens(value: string): string {
    if (!value.includes('<unk>')) return value;
    return value.replace(/\s*<unk>\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Conservative line-height-per-font-size ratio so tall glyphs from scripts
 *  like Devanagari (Hindi matras), Thai, Arabic, and Burmese don't get
 *  clipped at the top of the first line. */
const LINE_HEIGHT_RATIO = 1.5;

/** Gluestack text-size tokens → pixel font sizes (mirrors components/ui/text/styles). */
const SIZE_TO_FONT_PX: Record<TextSize, number> = {
    '2xs': 10,
    xs: 12,
    sm: 14,
    md: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
    '4xl': 36,
    '5xl': 48,
    '6xl': 60,
};

/**
 * A drop-in replacement for <Text>/<Heading> that auto-translates dynamic server content.
 *
 * Use this for dynamic server-generated text (news titles, AI responses, reasons).
 * For static UI strings (buttons, labels, settings), use <TranslatableStatic>.
 *
 * Layout behavior: this component renders a single Text/Heading element (no
 * wrapping View), so it drops into any parent layout exactly as a Text would.
 * The translated-indicator icon is rendered inline inside the Text content.
 *
 * Translation behavior:
 * 1. If the per-card "Show original" toggle is on → render `originalText ?? text`, no translation.
 * 2. Else if `appLanguage === 'en'` → render `text` as-is.
 * 3. Else → translate `text` → `appLanguage` via the iOS translator, cached globally.
 *    Translation is deferred until the view is within (or near) the viewport.
 */
const TranslatableDynamic: React.FC<TranslatableProps> = ({
    text,
    originalText,
    originalLanguage,
    as = 'text',
    size = 'md',
    className,
    style,
    numberOfLines,
    bold,
    italic,
    showToggle = false,
    onDisplayChange,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);

    // Keep the latest callback in a ref so the notify-effect can depend only on
    // the displayed values, not on an unstable inline callback identity (which
    // would otherwise re-fire — or loop — on every parent render).
    const onDisplayChangeRef = useRef(onDisplayChange);
    onDisplayChangeRef.current = onDisplayChange;

    // Local toggle state: lets the user flip between original and translated
    // text on the detail screen (only when `showToggle` is set).
    const [localShowOriginal, setLocalShowOriginal] = useState(false);

    const effectiveShowOriginal = showToggle && localShowOriginal;

    // If the original is already in the target language, don't translate —
    // just show the original.
    const originalIsTargetLang =
        !!originalText && languagesMatch(originalLanguage, appLanguage);

    const needsTranslation =
        !effectiveShowOriginal
        && !!appLanguage
        && appLanguage !== 'en'
        && !originalIsTargetLang;

    // Per-key subscription (NOT the whole cache Map). The store mutates the
    // cache in place and bumps `cacheVersion`, so zustand re-runs this selector
    // on every translation completion — but Object.is on the returned string
    // means only the node whose key just landed actually re-renders. Selecting
    // the whole Map here would re-render every mounted TranslatableDynamic on
    // every translation anywhere (2+ per feed card).
    const cachedTranslation = useAppLanguageStore((s) =>
        needsTranslation ? s.cache.get(text) : undefined,
    );

    const nodeRef = useRef<MeasurableNode | null>(null);
    const setNodeRef = useCallback((node: unknown) => {
        nodeRef.current = node as MeasurableNode | null;
    }, []);
    const [isOnScreen, setIsOnScreen] = useState(false);
    // Avoid firing multiple translation requests for the same (text, language) pair.
    const firedRef = useRef<string | null>(null);

    // Measure the node's window-space position and flip `isOnScreen` if visible.
    const checkVisibility = useCallback(() => {
        const node = nodeRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        try {
            node.measureInWindow((_x, y, _w, h) => {
                const { height: screenH } = Dimensions.get('window');
                const visible =
                    y + h > -VISIBILITY_BUFFER_PX &&
                    y < screenH + VISIBILITY_BUFFER_PX;
                if (visible) {
                    setIsOnScreen(true);
                }
            });
        } catch {
            // measureInWindow can throw if the node is detached mid-layout; ignore.
        }
    }, []);

    // Reset visibility (and local toggle) when the text prop changes (e.g. FlatList
    // recycling), then re-measure on the next tick so recycled cells re-check at
    // their new position.
    useEffect(() => {
        setIsOnScreen(false);
        setLocalShowOriginal(false);
        firedRef.current = null;
        const id = setTimeout(checkVisibility, 0);
        return () => clearTimeout(id);
    }, [text, checkVisibility]);

    // Subscribe to scroll ticks until we know the node is on screen. Once visible
    // we drop the subscription — no work after that.
    useEffect(() => {
        if (!needsTranslation) return;
        if (isOnScreen) return;
        const unsubscribe = subscribeScrollTick(checkVisibility);
        return unsubscribe;
    }, [needsTranslation, isOnScreen, checkVisibility]);

    // Fire the translation request once we're on screen and still need one.
    useEffect(() => {
        if (!needsTranslation) return;
        if (!isOnScreen) return;
        if (cachedTranslation != null) return;
        if (!text) return;

        const store = useAppLanguageStore.getState();
        if (store.pending.has(text)) return;

        const requestKey = `${text}::${appLanguage}`;
        if (firedRef.current === requestKey) return;
        firedRef.current = requestKey;

        store.addPending(text);
        logger.debug('[TranslatableDynamic] Requesting translation', {
            textPreview: text.slice(0, 20),
            originalLanguage,
            appLanguage,
        });
        translateText(text, appLanguage).then((translated) => {
            if (translated) {
                useAppLanguageStore.getState().cacheTranslation(text, translated);
            } else {
                logger.warn('[TranslatableDynamic] Translation unavailable, falling back to original text', {
                    textPreview: text.slice(0, 20),
                    originalLanguage,
                    appLanguage,
                });
                useAppLanguageStore.getState().removePending(text);
            }
        });
    }, [needsTranslation, isOnScreen, appLanguage, text, cachedTranslation, originalLanguage]);

    let displayText: string;
    if (effectiveShowOriginal || originalIsTargetLang) {
        // User asked for the original, or it's already in their language.
        displayText = originalText ?? text;
    } else if (needsTranslation && cachedTranslation != null) {
        // Machine-translated cache hit.
        displayText = cachedTranslation;
    } else if (needsTranslation) {
        // Translation still pending — prefer the original-language version
        // over the English source so we never flash English at users who
        // picked a non-English app language.
        displayText = originalText ?? text;
    } else {
        // appLanguage === 'en' or no translation needed — show the English
        // `text` (which for server-provided articles is the server-side
        // English translation of the original).
        displayText = text;
    }
    displayText = stripUnkTokens(displayText);

    // Whether the text on screen is the original-language variant (user toggled
    // to it, or it's already in their app language).
    const showingOriginal = effectiveShowOriginal || originalIsTargetLang;

    // Notify the parent (in an effect, never during render) whenever the
    // effective displayed text changes.
    useEffect(() => {
        onDisplayChangeRef.current?.({ showingOriginal, displayedText: displayText });
    }, [showingOriginal, displayText]);

    // Show the translate icon whenever the displayed text differs from the
    // original-language text. This covers both machine translations (iOS
    // translator) and server-side English translations (e.g. a Portuguese
    // article rendered in English via `title_en_internal_only`).
    const isTranslated =
        !effectiveShowOriginal && !!originalText && displayText !== originalText;

    // Show the toggle button when: showToggle is on and there is an original to switch to.
    const showToggleButton = showToggle && !!originalText && !originalIsTargetLang;

    // Inline icon — shown only in non-toggle mode.
    const translatedIndicator = isTranslated && !showToggleButton ? (
        <>
            <MaterialIcons name="translate" size={11} color="#9ca3af" />
            {' '}
        </>
    ) : null;

    const content = (
        <>
            {translatedIndicator}
            {displayText}
        </>
    );

    // Merge a conservative lineHeight into the style so tall non-Latin
    // glyphs (Devanagari matras, Thai, Arabic) don't get clipped. Caller
    // `style` spreads last so an explicit `lineHeight` override still wins.
    const fontPx = SIZE_TO_FONT_PX[size];
    const mergedStyle = {
        lineHeight: Math.round(fontPx * LINE_HEIGHT_RATIO),
        ...(style ?? {}),
    };

    const sharedProps = {
        ref: setNodeRef,
        onLayout: checkVisibility,
        className,
        style: mergedStyle,
        numberOfLines,
        bold,
        italic,
    };

    const renderTextNode = (children: React.ReactNode) => {
        if (as === 'heading') {
            return (
                <Heading size={size as any} {...sharedProps}>
                    {children}
                </Heading>
            );
        }
        return (
            <Text size={size} {...sharedProps}>
                {children}
            </Text>
        );
    };

    if (showToggleButton) {
        return (
            <View>
                {renderTextNode(displayText)}
                <Pressable
                    onPress={() => setLocalShowOriginal((v) => !v)}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        alignSelf: 'flex-start',
                        marginTop: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 999,
                        backgroundColor: '#1f2937',
                    }}
                >
                    <MaterialIcons name="translate" size={12} color="#9ca3af" />
                    <Text size="xs" style={{ color: '#9ca3af', marginLeft: 4 }}>
                        {localShowOriginal
                            ? t('clusterDetail.showTranslation')
                            : t('clusterDetail.showOriginal')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return renderTextNode(content);
};

export default TranslatableDynamic;
