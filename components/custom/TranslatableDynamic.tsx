import { Heading } from '@/components/ui/heading';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { canonicalizeLanguageCode } from '@/lib/language-codes';
import {
    requestTranslation,
    useTranslationSuppressed,
    type TranslationRequest,
} from '@/lib/translation-service';
import { subscribeTranslationEpoch } from '@/lib/translation-queue';
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

/** What a parent learns about the text currently on screen. */
export interface TranslatableDisplayState {
    /** The reader toggled to the original, or it was already in their language. */
    readonly showingOriginal: boolean;
    readonly displayedText: string;
    /**
     * Canonical language code of `displayedText`. Not derivable from
     * `showingOriginal`: the original-language text is also what renders while
     * a translation is pending and whenever the OS translator fails, and
     * `showingOriginal` is false in both of those cases.
     */
    readonly displayedLanguage: string | null;
}

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
    readonly onDisplayChange?: (state: TranslatableDisplayState) => void;
}

/** Loose match so `hi-IN` ≈ `hi`, `zh-Hans` ≈ `zh-CN`, etc. */
function languagesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
}

/** How far the untranslated text dims while its translation is in flight. */
const TRANSLATING_OPACITY = 0.6;

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
 * For static UI strings (buttons, labels, settings), use <TranslatableStatic>.
 *
 * Layout behavior: this component renders a single Text/Heading element (no
 * wrapping View), so it drops into any parent layout exactly as a Text would.
 *
 * Translation behavior:
 * 1. If the per-card "Show original" toggle is on → render `originalText ?? text`, no translation.
 * 2. Else if `appLanguage === 'en'` → render `text` as-is.
 * 3. Else → translate `text` → `appLanguage` via the OS translator, cached globally.
 *    Asked for only while the node is within (or near) the viewport: its
 *    request is re-ranked as it moves, cancelled when it leaves, and made
 *    again when it comes back. A failure (a timeout included) is never a
 *    latch: the node asks again once it has left the screen and come back, or
 *    remounts. Only the language breaker stops a language.
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

    // Nothing will be translated into this language right now — either the OS
    // translator has given up on it (the breaker) or it has not been verified
    // yet and the native-call gate is shut (see lib/translation-service).
    //
    // Fall back SILENTLY to the server-side English — `text` is already
    // title_en / description_en, so there is nothing to fetch and nothing to
    // translate. Note this is ENGLISH, never the source language: an article
    // in a language the reader does not speak, left untranslated, is worse
    // than the English we already hold. The source language renders only when
    // it IS the reader's language (`originalIsTargetLang`) or they asked for
    // it (`effectiveShowOriginal`). No banner, no alert, no interruption: the
    // affordance for the failed state is the red translate icon on the article
    // meta row, and one prompt minted per language elsewhere.
    const translationSuppressed = useTranslationSuppressed(appLanguage);

    const needsTranslation =
        !effectiveShowOriginal
        && !!appLanguage
        && appLanguage !== 'en'
        && !originalIsTargetLang
        && !translationSuppressed;

    // Per-key subscription (NOT the whole cache Map). The store mutates the
    // cache in place and bumps `cacheVersion`, so zustand re-runs this selector
    // on every translation completion — but Object.is on the returned string
    // means only the node whose key just landed actually re-renders. Selecting
    // the whole Map here would re-render every mounted TranslatableDynamic on
    // every translation anywhere (2+ per feed card).
    const cachedTranslation = useAppLanguageStore((s) =>
        needsTranslation ? s.cache.get(text) : undefined,
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
    /** Live, both ways: a node that scrolls away goes false again. */
    const [isOnScreen, setIsOnScreen] = useState(false);
    /**
     * Last measured window-space `y`: the node's place in the queue among the
     * rows on screen (top first). Per TEXT NODE rather than per card, so a
     * card's title and its reason rank separately, and it works on every list
     * with no viewability plumbing.
     */
    const lastYRef = useRef(0);
    /** This node's current request, if any. Cleared when it settles, when the
     *  node cancels it (left the screen, text change, unmount). */
    const requestRef = useRef<TranslationRequest | null>(null);
    /**
     * The last request FAILED (a timeout included) while the node stayed in
     * view. Not a latch: cleared when the node leaves the screen, when
     * suppression lifts, and by a remount. It only stops the node re-asking
     * on every tick while it sits there, which would burn the breaker.
     */
    const failedInViewRef = useRef(false);
    /**
     * True when the last request was DROPPED by the route-epoch sweep (not by
     * this node's own cancel). See the epoch-subscription effect below.
     */
    const wasDroppedRef = useRef(false);
    /** Bumped to re-run the request effect after a ref-only change. */
    const [retryToken, setRetryToken] = useState(0);

    /** Give up this node's request (it left, its text changed, it unmounted). */
    const cancelRequest = useCallback(() => {
        const request = requestRef.current;
        requestRef.current = null;
        request?.cancel();
    }, []);

    // Measure the node's window-space position and track whether it is on screen.
    const checkVisibility = useCallback(() => {
        const node = nodeRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        try {
            node.measureInWindow((_x, y, _w, h) => {
                const { height: screenH } = Dimensions.get('window');
                const visible =
                    y + h > -VISIBILITY_BUFFER_PX &&
                    y < screenH + VISIBILITY_BUFFER_PX;
                lastYRef.current = y;
                setIsOnScreen(visible);
                if (visible) requestRef.current?.setPriority({ visible: true, y });
            });
        } catch {
            // measureInWindow can throw if the node is detached mid-layout; ignore.
        }
    }, []);

    // Reset (and cancel) when the text prop changes (e.g. FlatList recycling),
    // then re-measure so recycled cells re-check at their new position.
    useEffect(() => {
        setIsOnScreen(false);
        setLocalShowOriginal(false);
        failedInViewRef.current = false;
        wasDroppedRef.current = false;
        // RETRY LADDER, not a single shot. Under Fabric, `measureInWindow` on a
        // freshly-mounted (or freshly-recycled) FlatList cell can return without
        // ever invoking its callback — the node has no committed shadow-tree
        // position yet — and there is no error to catch and no second chance.
        // Re-asking a few times costs one cheap measure each and self-heals as
        // soon as layout commits. A callback that never fires is NOT treated as
        // visible — an unresolved measure must not translate an off-screen node.
        const ids = [0, 150, 450].map((ms) => setTimeout(checkVisibility, ms));
        return () => {
            ids.forEach(clearTimeout);
            cancelRequest();
        };
    }, [text, checkVisibility, cancelRequest]);

    // A language switch: the old request is for a language the reader left.
    // Give it up so the request effect asks in the new one straight away.
    useEffect(() => {
        failedInViewRef.current = false;
        wasDroppedRef.current = false;
        return cancelRequest;
    }, [appLanguage, cancelRequest]);

    // Leaving the screen: give up the queue place, and forget a failure so the
    // node asks again when it comes back.
    useEffect(() => {
        if (isOnScreen) return;
        failedInViewRef.current = false;
        cancelRequest();
    }, [isOnScreen, cancelRequest]);

    // Listen to scroll ticks until the translation is cached, on screen or
    // off: the node has to notice leaving (to cancel) and coming back (to ask).
    useEffect(() => {
        if (!needsTranslation) return;
        if (cachedTranslation != null) return;
        return subscribeScrollTick(checkVisibility);
    }, [needsTranslation, cachedTranslation, checkVisibility]);

    // When suppression lifts — the gate opens because the language was just
    // verified, or a retry cleared the breaker — let a node that had failed
    // try once more. That matters most right after a successful language
    // switch: the feed behind the picker is exactly the set of nodes that were
    // gated.
    const wasSuppressedRef = useRef(translationSuppressed);
    useEffect(() => {
        if (wasSuppressedRef.current && !translationSuppressed) {
            failedInViewRef.current = false;
            setRetryToken((n) => n + 1);
        }
        wasSuppressedRef.current = translationSuppressed;
    }, [translationSuppressed]);

    // RECOVERY FROM A ROUTE-EPOCH DROP. The retry is keyed to the NEXT epoch
    // change rather than fired the instant the drop lands: the dropped screen
    // is still mounted underneath the pushed one and still measures at its
    // real coordinates, so an immediate retry would compete with the screen
    // the user is actually looking at. The natural "go back" re-arms it.
    useEffect(() => {
        if (!needsTranslation) return;
        return subscribeTranslationEpoch(() => {
            if (!wasDroppedRef.current) return;
            wasDroppedRef.current = false;
            setRetryToken((n) => n + 1);
        });
    }, [needsTranslation]);

    // Ask for the translation while on screen and still needed. Requests for
    // the same text join (lib/translation-service), so a node whose text is
    // already in flight elsewhere shares that call and its outcome.
    useEffect(() => {
        if (!needsTranslation) return;
        if (!isOnScreen) return;
        if (cachedTranslation != null) return;
        if (!text) return;
        if (requestRef.current) return;
        if (failedInViewRef.current || wasDroppedRef.current) return;

        const store = useAppLanguageStore.getState();
        store.addPending(text);
        logger.debug('[TranslatableDynamic] Requesting translation', {
            textPreview: text.slice(0, 20),
            originalLanguage,
            appLanguage,
        });
        // The language this call is FOR. Checked on completion: a language
        // switch cannot stop a call already in flight, so a German result can
        // land after the user moved to French, and `cacheTranslation` keys the
        // persisted row by whatever the store says NOW. Caching it would be a
        // permanent wrong-language row.
        const requestedLanguage = appLanguage;
        const request = requestTranslation(text, appLanguage, {
            rank: { visible: true, y: lastYRef.current },
        });
        requestRef.current = request;
        void request.promise.then((result) => {
            // Still this node's live request, or one it gave up (left, text
            // change, unmount)? A given-up request still caches a success.
            const mine = requestRef.current === request;
            if (mine) requestRef.current = null;
            const state = useAppLanguageStore.getState();
            if (state.appLanguage !== requestedLanguage) {
                state.removePending(text);
                return;
            }
            if (result.status === 'ok' && result.text) {
                // Joined nodes all land here; write the cache (and disk) once.
                if (state.cache.get(text) == null) state.cacheTranslation(text, result.text);
                else state.removePending(text);
                return;
            }
            state.removePending(text);
            if (!mine) return;
            if (result.status === 'dropped') {
                // NOT a failure: the route moved on before we asked the OS.
                // Wait for the next route change, then ask again.
                wasDroppedRef.current = true;
                return;
            }
            logger.warn('[TranslatableDynamic] Translation unavailable, falling back to original text', {
                textPreview: text.slice(0, 20),
                originalLanguage,
                appLanguage,
            });
            failedInViewRef.current = true;
        });
    }, [
        needsTranslation,
        isOnScreen,
        appLanguage,
        text,
        cachedTranslation,
        translationPending,
        originalLanguage,
        retryToken,
    ]);

    // `displayText` and `displayedLanguage` are assigned together, branch by
    // branch — deriving the language separately afterwards would drift from
    // whichever variant actually rendered. Where the fallback is
    // `originalText ?? text`, the language is the original's ONLY if
    // `originalText` exists; otherwise `text` rendered, and `text` is English
    // by this app's design (title_en, title_en_internal_only, reason).
    let displayText: string;
    let displayedLanguage: string | null;
    const originalLanguageCanonical = canonicalizeLanguageCode(originalLanguage);
    if (effectiveShowOriginal || originalIsTargetLang) {
        // User asked for the original, or it's already in their language.
        displayText = originalText ?? text;
        displayedLanguage = originalText ? originalLanguageCanonical : 'en';
    } else if (needsTranslation && cachedTranslation != null) {
        // Machine-translated cache hit.
        displayText = cachedTranslation;
        displayedLanguage = appLanguage;
    } else if (needsTranslation) {
        // Translation still pending — prefer the original-language version
        // over the English source so we never flash English at users who
        // picked a non-English app language.
        displayText = originalText ?? text;
        displayedLanguage = originalText ? originalLanguageCanonical : 'en';
    } else {
        // appLanguage === 'en' or no translation needed — show the English
        // `text` (which for server-provided articles is the server-side
        // English translation of the original).
        displayText = text;
        displayedLanguage = 'en';
    }
    displayText = stripUnkTokens(displayText);

    // Whether the text on screen is the original-language variant (user toggled
    // to it, or it's already in their app language).
    const showingOriginal = effectiveShowOriginal || originalIsTargetLang;

    // Notify the parent (in an effect, never during render) whenever the
    // effective displayed text changes.
    useEffect(() => {
        onDisplayChangeRef.current?.({ showingOriginal, displayedText: displayText, displayedLanguage });
    }, [showingOriginal, displayText, displayedLanguage]);

    // Show the toggle button when: showToggle is on and there is an original to switch to.
    const showToggleButton = showToggle && !!originalText && !originalIsTargetLang;

    // N9: the text on screen is about to be replaced by its translation. Dim it
    // and say so inline, so the swap (and the re-wrap it can cause) reads as a
    // translation arriving rather than as the card changing under the reader.
    // Inline, not a new row: this component must stay ONE Text node so it drops
    // into any parent layout exactly as a Text would.
    const translating =
        needsTranslation && cachedTranslation == null && translationPending && !showToggleButton;

    // No glyph before translated text (owner: the 文A mark is gone
    // everywhere); the detail screen's "Show original" toggle remains the one
    // place that says a text is translated.

    const content = (
        <>
            {displayText}
            {translating ? (
                <Text
                    size="xs"
                    testID="translatable-pending"
                    style={{ color: '#9ca3af', fontWeight: '400', fontStyle: 'normal' }}
                >
                    {'  '}
                    {t('feed.translatingCaption')}
                </Text>
            ) : null}
        </>
    );

    // Line height comes from the size token's class now (see the note above),
    // so the caller's style is passed straight through. Dimmed while a
    // translation is in flight (N9).
    const mergedStyle = translating
        ? [style ?? {}, { opacity: TRANSLATING_OPACITY }]
        : (style ?? {});

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
                <Heading size={size} {...sharedProps}>
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
