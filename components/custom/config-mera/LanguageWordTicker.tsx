import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { Text } from '@/components/ui/text';
import { LANGUAGE_WORDS } from '@/lib/language-words';
import { useThemeColors } from '@/lib/theme/tokens';

const FADE_MS = 300;
const DISPLAY_MS = 2000;

const LanguageWordTicker: React.FC = () => {
    const [index, setIndex] = useState(0);
    const opacity = useRef(new Animated.Value(1)).current;
    const colors = useThemeColors();

    useEffect(() => {
        let cancelled = false;
        let timeout: ReturnType<typeof setTimeout>;

        const cycle = () => {
            Animated.timing(opacity, {
                toValue: 0,
                duration: FADE_MS,
                useNativeDriver: true,
            }).start(({ finished }) => {
                if (!finished || cancelled) return;
                setIndex((prev) => (prev + 1) % LANGUAGE_WORDS.length);
                Animated.timing(opacity, {
                    toValue: 1,
                    duration: FADE_MS,
                    useNativeDriver: true,
                }).start(({ finished: f }) => {
                    if (!f || cancelled) return;
                    timeout = setTimeout(cycle, DISPLAY_MS);
                });
            });
        };

        timeout = setTimeout(cycle, DISPLAY_MS);
        return () => {
            cancelled = true;
            clearTimeout(timeout);
            opacity.stopAnimation();
            opacity.setValue(1);
        };
    }, [opacity]);

    return (
        <Animated.View style={[styles.container, { opacity }]}>
            <Text style={[styles.text, { color: colors.icon }]}>{LANGUAGE_WORDS[index]}</Text>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-end',
    },
    text: {
        fontSize: 14,
        textAlign: 'right',
    },
});

export default LanguageWordTicker;
