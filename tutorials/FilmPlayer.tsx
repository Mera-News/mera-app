// Plays a tutorial film in the app: start to finish, no buttons (owner), then
// `onEnd`. The clock runs on the native driver, so the JS thread does nothing
// while it plays. Mounted by TutorialPlayer for a `flow` chapter, under its
// `tutorial` restart hold.
//
// Lite or Reduce Motion: no motion, so each scene shows its settled frame for
// its own length, then the next. A screen reader gets the whole script as one
// label, since the film turns its scenes by itself.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, I18nManager, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { useTutorialCopy } from '@/components/custom/tutorials/use-tutorial-copy';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { feedShotFor } from './film/shots';
import { STAGE } from './film/stage';
import { FADE_MS } from './film/timeline';
import { WelcomeFilm } from './film/welcome';
import { WELCOME_SPANS as SPANS, resolveWelcomeCopy, sceneLines } from './film/welcome-script';

const TOTAL_MS = SPANS[SPANS.length - 1].end;

export const FilmPlayer: React.FC<{ readonly onEnd: () => void }> = ({ onEnd }) => {
    const t = useTutorialCopy();
    const copy = useMemo(() => resolveWelcomeCopy(t), [t]);
    const motion = useMotionAllowed();
    const appLanguage = useAppLanguageStore((s) => s.appLanguage);
    const clock = useRef(new Animated.Value(0)).current;
    const [scale, setScale] = useState(0);
    // Hosts pass an inline onEnd; the film must not restart when it changes.
    const endRef = useRef(onEnd);
    useEffect(() => {
        endRef.current = onEnd;
    }, [onEnd]);

    useEffect(() => {
        if (motion) {
            const run = Animated.timing(clock, { toValue: TOTAL_MS, duration: TOTAL_MS, easing: Easing.linear, useNativeDriver: true });
            run.start(({ finished }) => {
                if (finished) endRef.current();
            });
            return () => run.stop();
        }
        const timers = SPANS.map((s) => setTimeout(() => clock.setValue(s.end - FADE_MS), s.start));
        timers.push(setTimeout(() => endRef.current(), TOTAL_MS));
        return () => timers.forEach(clearTimeout);
    }, [motion, clock]);

    const script = useMemo(() => SPANS.flatMap((s) => sceneLines(s.id, copy)).join('. '), [copy]);
    const onLayout = (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        setScale(Math.min(width / STAGE.width, height / STAGE.height));
    };

    return (
        <View testID="tutorial-film" style={styles.root} onLayout={onLayout} accessible accessibilityLabel={script}>
            {scale > 0 ? (
                <View style={[styles.film, { transform: [{ scale }] }]}>
                    <WelcomeFilm t={clock} copy={copy} rtl={I18nManager.isRTL} feedShot={feedShotFor(appLanguage)} />
                </View>
            ) : null}
        </View>
    );
};

const styles = StyleSheet.create({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000000', overflow: 'hidden' },
    film: { width: STAGE.width, height: STAGE.height },
});
