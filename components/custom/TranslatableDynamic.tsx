import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { Heading } from '@/components/ui/heading';
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '@/components/ui/popover';
import { Pressable } from '@/components/ui/pressable';
import { ShimmerText, useSweepAllowed } from '@/components/ui/shimmer';
import { Text } from '@/components/ui/text';
import { canonicalizeLanguageCode } from '@/lib/algorithms/language-codes';
import { TYPE_SCALE, tokenFromClassName, type TypeToken } from '@/lib/algorithms/scale';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import {
    translateTextDetailed,
    useTranslationBlocked,
    useTranslationSuppressed,
} from '@/lib/translation-service';
import { visibilityPriority } from '@/lib/translation-queue';
import { translationCacheKey, useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useTextScale } from '@/lib/typography/TextScaleContext';
import { subscribeScrollTick } from '@/lib/visibility-tick';
import logger from '@/lib/logger';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { useColors } from '@/lib/theme/tokens';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dimensions, View, useWindowDimensions } from 'react-native';

type MeasurableNode = {
    measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
    ) => void;
};

type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '2xs' | '5xl' | '6xl';

/** What a parent learns about the text currently on screen. */
export interface TranslatableDisplayState {
    /** The reader toggled to the original, or it was already in their language. */
    readonly showingOriginal: boolean;
    readonly displayedText: string;
    /**
     * Canonical language code of `displayedText`: the original's when it is
     * shown, the app language for a translation, 'en' for the English
     * fallback (pending, failed, blocked).
     */
    readonly displayedLanguage: string | null;
    /** The failed glyph is showing: a card root appends the failure to its label. */
    readonly translationFailed: boolean;
}

interface TranslatableProps {
    /** Translatable source. Assumed to be English. */
    readonly text: string;
    /**
     * Original-language version (DB-stored). Shown ONLY when the per-card
     * "Show original" toggle (see `showToggle`) is on or the original language
     * already matches the user's app language. Pending and failed translations
     * show the English `text`, never this: a language the reader may not read
     * is worse than the English we hold. Used as a last resort when `text` is
     * empty.
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
    readonly onDisplayChange?: (state: TranslatableDisplayState) => void;
    /**
     * Detail screen only: a machine-translated text ends with a plain,
     * decorative translate glyph. Cards never pass it.
     */
    readonly showTranslatedGlyph?: boolean;
}

/** Loose match so `hi-IN` ≈ `hi`, `zh-Hans` ≈ `zh-CN`, etc. */
function languagesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}

/** How far the untranslated text dims while its translation is in flight, when
 *  the shimmer cannot run (Lite, Reduce Motion, screen not looked at). */
const TRANSLATING_OPACITY = 0.6;

/** The smallest touch frame iOS asks for. */
const TOUCH_FRAME = 44;

/** Layout keys that belong on a temporary wrapper View, not on the Text inside it. */
const LAYOUT_STYLE_KEYS = new Set([
    'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
    'width', 'minWidth', 'maxWidth',
    'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'marginHorizontal', 'marginVertical', 'marginStart', 'marginEnd',
]);
const LAYOUT_CLASS_RE = /^-?(m[trblxyse]?-|flex-(1|auto|none|initial)$|grow|shrink|basis-|w-|min-w-|max-w-|self-)/;

/** Splits a caller's class and style into the wrapper's layout and the Text's typography. */
function splitLayout(className: string | undefined, style: Record<string, unknown> | undefined) {
    const classes = (className ?? '').split(/\s+/).filter(Boolean);
    const outerStyle: Record<string, unknown> = {};
    const innerStyle: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(style ?? {})) (LAYOUT_STYLE_KEYS.has(k) ? outerStyle : innerStyle)[k] = v;
    return {
        outerClass: classes.filter((c) => LAYOUT_CLASS_RE.test(c)).join(' ') || undefined,
        innerClass: classes.filter((c) => !LAYOUT_CLASS_RE.test(c)).join(' ') || undefined,
        outerStyle,
        innerStyle,
    };
}

/**
 * The glyph at the end of a text: failed (slashed, tappable, tooltip) or
 * translated (plain, decorative). Its own 44pt frame is pulled back by
 * negative margins to the glyph's box, so it never moves the line it ends.
 */
function EndGlyph({
    kind,
    fontPx,
    boxHeight,
    inCard,
}: {
    kind: 'failed' | 'translated';
    fontPx: number;
    boxHeight: number;
    inCard: boolean;
}) {
    const { t } = useTranslation();
    const colors = useColors();
    const { width: screenWidth } = useWindowDimensions();
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    const icon =
        kind === 'failed' ? (
            <MaterialCommunityIcons name="translate-off" size={fontPx} color={colors.ink3} />
        ) : (
            <MaterialIcons name="translate" size={fontPx} color={colors.ink3} />
        );
    const box = { width: fontPx, height: boxHeight, marginLeft: Math.round(fontPx * 0.3) };
    if (kind === 'translated') {
        return (
            <View testID="translatable-translated" style={[box, { alignItems: 'center', justifyContent: 'center' }]} {...DECORATIVE_ICON_A11Y}>
                {icon}
            </View>
        );
    }
    const label = t('feed.translationFailed');
    return (
        <View style={box}>
            <Popover
                isOpen={open}
                onClose={close}
                placement="top"
                offset={6}
                size="sm"
                // VoiceOver cannot reach portalled popover content; a native modal is on top.
                useRNModal
                trigger={(triggerProps) => (
                    <Pressable
                        {...triggerProps}
                        testID="translatable-failed"
                        onPress={() => setOpen(true)}
                        // A card speaks the failure in its root label, so the glyph is hidden there.
                        {...(inCard
                            ? DECORATIVE_ICON_A11Y
                            : { accessibilityRole: 'button' as const, accessibilityLabel: label })}
                        style={{
                            width: TOUCH_FRAME,
                            height: TOUCH_FRAME,
                            marginHorizontal: (fontPx - TOUCH_FRAME) / 2,
                            marginVertical: (boxHeight - TOUCH_FRAME) / 2,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <View {...DECORATIVE_ICON_A11Y}>{icon}</View>
                    </Pressable>
                )}
            >
                <PopoverBackdrop />
                <PopoverContent style={{ maxWidth: screenWidth - 32 }}>
                    <PopoverBody testID="translatable-failed-tooltip" onAccessibilityEscape={close}>
                        <Text size="sm" className="text-ink">
                            {label}
                        </Text>
                    </PopoverBody>
                </PopoverContent>
            </Popover>
        </View>
    );
}

/** The in-flight text: shimmer when motion may run, else the old static dim. */
function TranslatingText({
    renderCopy,
    outerClass,
    outerStyle,
}: {
    renderCopy: (extra?: Record<string, unknown>) => React.ReactNode;
    outerClass?: string;
    outerStyle: Record<string, unknown>;
}) {
    const sweep = useSweepAllowed();
    return (
        <View
            testID="translatable-pending"
            className={outerClass}
            style={outerStyle}
            accessibilityState={{ busy: true }}
        >
            {sweep ? (
                <ShimmerText renderText={(color) => renderCopy({ color })} />
            ) : (
                renderCopy({ opacity: TRANSLATING_OPACITY })
            )}
        </View>
    );
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

/*
 * The local `LINE_HEIGHT_RATIO = 1.5` and `SIZE_TO_FONT_PX` table that used to
 * live here are gone.
 *
 * They existed to force a script-safe line box onto translated text, because
 * Tailwind's leading gets tighter as type gets bigger and React Native treats
 * `lineHeight` as a hard box — Devanagari matras and Thai upper vowels were
 * being sliced. That friction is now solved one level down: EVERY step of the
 * scale in `tailwind.config.js` carries an explicit lineHeight at >= 1.4x, so
 * the class this component already renders brings its own headroom.
 *
 * Removing it was not merely tidiness. The injected `lineHeight` was an INLINE
 * style, and an inline style beats the class — so it would have overridden the
 * scaled lineHeight that the in-app text-size control applies, leaving enlarged
 * glyphs crammed into a default-sized line box.
 *
 * (The deleted table is also the receipt for the scale being wrong: it mapped
 * xs->12, sm->14, md->16, i.e. the rem-16 values, while NativeWind's
 * `inlineRem: 14` default was actually rendering those steps at 10.5/12.25/14.)
 */
/**
 * A drop-in replacement for <Text>/<Heading> that auto-translates dynamic server content.
 *
 * Use this for dynamic server-generated text (news titles, AI responses, reasons).
 * For static UI strings (buttons, labels, settings), use `t()` directly.
 *
 * Layout behavior: one Text/Heading element, so it drops into any parent layout
 * exactly as a Text would, EXCEPT while a translation is in flight (a View
 * holding the shimmer) and when a clamped text failed (a row: Text, then the
 * glyph as a sibling, so an ellipsis can never hide it). Those wrappers take
 * the caller's layout props; typography stays on the Text. Never nest this
 * inside another Text.
 *
 * Translation behavior:
 * 1. "Show original" toggled, or the original is already in the app language → the original.
 * 2. A cached translation → the translation (it wins over any earlier failure).
 * 3. Otherwise → the English `text` (pending, failed, blocked, English app).
 *    Translation is asked for once the view is within (or near) the viewport.
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
    showTranslatedGlyph = false,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const textScale = useTextScale();
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

    // The reader should see this text in their language.
    const wantsTranslation =
        !effectiveShowOriginal
        && !!appLanguage
        && appLanguage !== 'en'
        && !originalIsTargetLang;

    // Nothing will be translated into this language right now: the OS
    // translator has given up on it (the breaker) or it is not verified yet and
    // the native-call gate is shut (see lib/translation-service). No request
    // goes out; the English `text` shows. Only the breaker block is a failure
    // the reader is told about (the glyph); an unverified language is not.
    const translationSuppressed = useTranslationSuppressed(appLanguage);
    const translationBlocked = useTranslationBlocked(appLanguage) != null;

    const needsTranslation = wantsTranslation && !translationSuppressed;

    // Per-key subscription (NOT the whole cache Map). The store mutates the
    // cache in place and bumps `cacheVersion`, so zustand re-runs this selector
    // on every translation completion — but Object.is on the returned string
    // means only the node whose key just landed actually re-renders. Selecting
    // the whole Map here would re-render every mounted TranslatableDynamic on
    // every translation anywhere (2+ per feed card). Read even while
    // suppressed: a translation already held always wins.
    const cachedTranslation = useAppLanguageStore((s) =>
        wantsTranslation ? s.cache.get(translationCacheKey(text)) : undefined,
    );
    // A request for THIS text is in flight (same per-key subscription shape as
    // above: a boolean, so only this node re-renders when it flips).
    const translationPending = useAppLanguageStore((s) =>
        needsTranslation ? s.pending.has(text) : false,
    );

    const nodeRef = useRef<MeasurableNode | null>(null);
    const setNodeRef = useCallback((node: unknown) => {
        nodeRef.current = node as MeasurableNode | null;
    }, []);
    const [isOnScreen, setIsOnScreen] = useState(false);
    // Avoid firing multiple translation requests for the same (text, language) pair.
    const firedRef = useRef<string | null>(null);
    /**
     * Last measured window-space `y`. This IS the node's visible rank, and it is
     * what orders the translation queue — the text nearest the top of the
     * viewport is translated first, the text scrolled past waits.
     *
     * Deliberately measured-y rather than the Feed's `viewabilityConfigCallback
     * Pairs`: it is per-TEXT-NODE rather than per-card, it needs no plumbing
     * through the card components, and it works identically on the Dashboard
     * and Explore lists, which have no viewability config at all. We already
     * measure this value on every visibility check and were throwing it away.
     */
    const lastYRef = useRef(0);
    /**
     * How the last request for this text ended, when it did not translate.
     * 'failed' draws the glyph; 'dropped' (the route moved on before the OS was
     * asked) is the queue working and draws nothing. Both re-ask, see below.
     */
    const [lastOutcome, setLastOutcome] = useState<'failed' | 'dropped' | null>(null);
    /** Bumped to re-run the fire-effect for a re-ask. */
    const [retryToken, setRetryToken] = useState(0);

    // Measure the node's window-space position and flip `isOnScreen` if visible.
    const checkVisibility = useCallback(() => {
        const node = nodeRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        try {
            node.measureInWindow((x, y, w, h) => {
                const { width: screenW, height: screenH } = Dimensions.get('window');
                // Horizontally too, with no buffer: a swipe pager keeps its
                // neighbouring panels mounted exactly one screen width to
                // either side at the same `y` (ux2 B3), and those must not
                // count. A horizontal strip card partly on screen still does.
                const visible =
                    y + h > -VISIBILITY_BUFFER_PX &&
                    y < screenH + VISIBILITY_BUFFER_PX &&
                    // A zero-width measure says nothing about x: vertical only.
                    (w === 0 || (x + w > 0 && x < screenW));
                if (visible) {
                    lastYRef.current = y;
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
        setLastOutcome(null);
        firedRef.current = null;
        // RETRY LADDER, not a single shot. Under Fabric, `measureInWindow` on a
        // freshly-mounted (or freshly-recycled) FlatList cell can return without
        // ever invoking its callback — the node has no committed shadow-tree
        // position yet — and there is no error to catch and no second chance:
        // `isOnScreen` simply stays false. That left the first scroll as the
        // only thing that resolved the check, so titles swapped from the
        // original to the translation mid-scroll and re-wrapped (2↔3 lines).
        // Re-asking a few times costs one cheap measure each and self-heals as
        // soon as layout commits. A callback that never fires is NOT treated as
        // visible — an unresolved measure must not translate an off-screen node.
        const ids = [0, 150, 450].map((ms) => setTimeout(checkVisibility, ms));
        return () => ids.forEach(clearTimeout);
    }, [text, checkVisibility]);

    // Subscribe to scroll ticks until we know the node is on screen. Once visible
    // we drop the subscription — no work after that.
    useEffect(() => {
        if (!needsTranslation) return;
        if (isOnScreen) return;
        const unsubscribe = subscribeScrollTick(checkVisibility);
        return unsubscribe;
    }, [needsTranslation, isOnScreen, checkVisibility]);

    // When suppression lifts — the gate opens because the language was just
    // verified, or a retry cleared the breaker — let a node that had already
    // fired-and-failed (or never fired at all) try once more. `firedRef` is
    // keyed on (text, language), neither of which changed, so without this
    // every node already on screen would stay English until the list recycled
    // it. That matters most right after a successful language switch: the feed
    // behind the picker is exactly the set of nodes that were gated.
    const wasSuppressedRef = useRef(translationSuppressed);
    useEffect(() => {
        if (wasSuppressedRef.current && !translationSuppressed) {
            firedRef.current = null;
            setLastOutcome(null);
        }
        wasSuppressedRef.current = translationSuppressed;
    }, [translationSuppressed]);

    // RE-ASK. `firedRef` latches on (text, language), and neither changes on a
    // drop or a failure, so without this a dropped title (tap a card, the route
    // sweep drops the queued titles, come back) stays English for the session.
    // Gated on the reader looking at this text: an immediate retry from a
    // screen still mounted under a pushed one would compete with the screen in
    // front. A drop re-asks whenever the gate is open; a failure only on the
    // gate's RISING edge, because the service answers an exhausted text with
    // 'failed' at once and re-asking while the gate stays open would loop.
    // The per-text retry budget lives in the service, not here.
    const askGate = useIsFocusedSafe();
    const prevGateRef = useRef(askGate);
    useEffect(() => {
        const rose = askGate && !prevGateRef.current;
        prevGateRef.current = askGate;
        if (!askGate || !needsTranslation) return;
        if (lastOutcome === 'dropped' || (lastOutcome === 'failed' && rose)) {
            firedRef.current = null;
            setLastOutcome(null);
            setRetryToken((n) => n + 1);
        }
    }, [askGate, lastOutcome, needsTranslation]);

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
        // The language this call is FOR. Captured here, checked on completion:
        // the store's `appLanguage` at completion time is not necessarily the
        // one we asked for. A language switch does not (and cannot) stop a call
        // already in flight, so a German result can land after the user has
        // moved to French — and `cacheTranslation` keys the persisted row by
        // whatever the store says NOW. In memory that was self-healing (the Map
        // is replaced on every switch); on disk it would be a permanent
        // wrong-language row that every later launch faithfully reloads.
        const requestedLanguage = appLanguage;

        // Priority = where this node sits on screen right now. Lower is sooner,
        // so the headline at the top of the viewport beats the one the user has
        // already scrolled past, and both beat anything above the fold.
        translateTextDetailed(text, appLanguage, {
            priority: visibilityPriority(lastYRef.current),
        }).then((result) => {
            useAppLanguageStore.getState().removePending(text);
            if (useAppLanguageStore.getState().appLanguage !== requestedLanguage) {
                // Answer for a language the reader has left. Drop it entirely —
                // caching it would mislabel it (see above), and the node has
                // already re-fired for the new language.
                return;
            }
            if (result.status === 'ok' && result.text) {
                useAppLanguageStore.getState().cacheTranslation(text, result.text);
                return;
            }
            if (result.status === 'dropped') {
                setLastOutcome('dropped');
                return;
            }
            if (result.status === 'failed') {
                logger.warn('[TranslatableDynamic] Translation failed, showing English', {
                    textPreview: text.slice(0, 20),
                    originalLanguage,
                    appLanguage,
                });
                setLastOutcome('failed');
            }
            // Anything else (no native attempt was made) is not this text's failure.
        });
    }, [
        needsTranslation,
        isOnScreen,
        appLanguage,
        text,
        cachedTranslation,
        originalLanguage,
        retryToken,
    ]);

    // `displayText` and `displayedLanguage` are assigned together, branch by
    // branch — deriving the language separately afterwards would drift from
    // whichever variant actually rendered.
    let displayText: string;
    let displayedLanguage: string | null;
    const originalLanguageCanonical = canonicalizeLanguageCode(originalLanguage);
    const showingOriginal = effectiveShowOriginal || originalIsTargetLang;
    const translated = wantsTranslation && cachedTranslation != null;
    if (showingOriginal) {
        // User asked for the original, or it's already in their language.
        displayText = originalText ?? text;
        displayedLanguage = originalText ? originalLanguageCanonical : 'en';
    } else if (translated) {
        displayText = cachedTranslation;
        displayedLanguage = appLanguage;
    } else if (text) {
        // English: an English app, or the translation is pending, failed or
        // blocked. Never the original here: see `originalText`.
        displayText = text;
        displayedLanguage = 'en';
    } else {
        displayText = originalText ?? '';
        displayedLanguage = originalText ? originalLanguageCanonical : 'en';
    }
    displayText = stripUnkTokens(displayText);

    // A cached translation always wins over an earlier failure.
    const failed = wantsTranslation && !translated && (lastOutcome === 'failed' || translationBlocked);

    // Notify the parent (in an effect, never during render) whenever the
    // effective displayed text changes.
    useEffect(() => {
        onDisplayChangeRef.current?.({
            showingOriginal,
            displayedText: displayText,
            displayedLanguage,
            translationFailed: failed,
        });
    }, [showingOriginal, displayText, displayedLanguage, failed]);

    // Show the toggle button when: showToggle is on and there is an original to switch to.
    const showToggleButton = showToggle && !!originalText && !originalIsTargetLang;

    // The text on screen is about to be replaced by its translation: the
    // shimmer says so, so the swap (and the re-wrap it can cause) reads as a
    // translation arriving rather than as the card changing under the reader.
    const translating = needsTranslation && !translated && translationPending;

    const glyph: 'failed' | 'translated' | null = failed
        ? 'failed'
        : translated && showTranslatedGlyph
            ? 'translated'
            : null;
    // A clamped text (cards) puts the glyph beside it, where an ellipsis cannot hide it.
    const clamped = numberOfLines != null;
    const needsWrapper = translating || (glyph != null && clamped);
    const layout = needsWrapper ? splitLayout(className, style) : null;

    const token: TypeToken = tokenFromClassName(className) ?? (size === 'md' ? 'base' : size);
    const step = TYPE_SCALE[token];
    const fontPx = Math.round(step.fontSize * textScale);
    const linePx = Math.round(step.lineHeight * textScale);

    // English in a non-English app: tell the screen reader, and keep Latin LTR in Arabic.
    const englishInForeignApp = displayedLanguage === 'en' && !!appLanguage && appLanguage !== 'en';

    const renderTextNode = (children: React.ReactNode, extra?: Record<string, unknown>, measured = true) => {
        const baseStyle = layout ? layout.innerStyle : (style ?? {});
        const props = {
            ...(measured ? { ref: setNodeRef, onLayout: checkVisibility } : null),
            className: layout ? layout.innerClass : className,
            style: [
                baseStyle,
                englishInForeignApp ? { writingDirection: 'ltr' as const } : null,
                extra ?? null,
            ],
            numberOfLines,
            bold,
            italic,
            ...(englishInForeignApp ? { accessibilityLanguage: 'en' } : null),
        };
        if (as === 'heading') {
            return (
                <Heading size={size} {...props}>
                    {children}
                </Heading>
            );
        }
        return (
            <Text size={size} {...props}>
                {children}
            </Text>
        );
    };

    let body: React.ReactNode;
    if (translating && layout) {
        body = (
            <TranslatingText
                outerClass={layout.outerClass}
                outerStyle={layout.outerStyle}
                renderCopy={(extra) => renderTextNode(displayText, extra, !extra?.color || extra.color === colors.ink2)}
            />
        );
    } else if (glyph && layout) {
        body = (
            <View className={layout.outerClass} style={[{ flexDirection: 'row', alignItems: 'flex-end' }, layout.outerStyle]}>
                {renderTextNode(displayText, { flexShrink: 1 })}
                <EndGlyph kind={glyph} fontPx={fontPx} boxHeight={linePx} inCard />
            </View>
        );
    } else if (glyph) {
        // Unclamped (detail): inline at the end of the text's own last line.
        body = renderTextNode(
            <>
                {displayText}
                <EndGlyph kind={glyph} fontPx={fontPx} boxHeight={fontPx} inCard={false} />
            </>,
        );
    } else {
        body = renderTextNode(displayText);
    }

    if (showToggleButton) {
        return (
            <View>
                {body}
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
                        backgroundColor: colors.surfaceRaised,
                    }}
                >
                    <MaterialIcons name="translate" size={12} color={colors.ink2} />
                    <Text size="xs" style={{ color: colors.ink2, marginLeft: 4 }}>
                        {localShowOriginal
                            ? t('clusterDetail.showTranslation')
                            : t('clusterDetail.showOriginal')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return body;
};

export default TranslatableDynamic;
