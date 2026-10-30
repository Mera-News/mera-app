// The stage films are drawn on: one continuous shot on one clock `t` (ms, an
// Animated.Value). The app drives `t` with a native-driver timing; the video
// export sets it per frame. Every object keeps living across scenes and only its
// keyframed position, scale and opacity change, so a scene change is a morph,
// never a cut (owner). A morph between two looks is two stacked objects on the
// same path, one fading out as the other fades in.
//
// IMPORTS ARE LIMITED to react, react-native, react-native-svg and
// @expo/vector-icons, so the export can bundle this for react-native-web.
// Only opacity and transforms animate (what the native driver runs), and no
// interpolation takes `easing` (the native driver rejects it), so `kf` samples
// the ease into its ranges.

import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Animated, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export type Clock = Animated.Value;
export type IconName = React.ComponentProps<typeof MaterialIcons>['name'];
/** [ms, value] pairs, strictly increasing in ms. One pair = a constant. */
export type Keys = readonly (readonly [number, number])[];
type Num = number | Animated.AnimatedInterpolation<number>;

/** Stage size; hosts scale it to fit. */
export const STAGE = { width: 1080, height: 1920 } as const;

export const C = {
    ground: '#000000',
    ink: '#FFFFFF',
    ink2: 'rgba(255,255,255,0.72)',
    ink3: 'rgba(255,255,255,0.5)',
    sub: '#D4D4D4',
    accent: '#E78A53',
    accentSoft: 'rgba(231,138,83,0.18)',
    accentEdge: 'rgba(231,138,83,0.5)',
    done: '#4ADE80',
    keep: '#22C55E',
    drop: '#EF4444',
    fill: 'rgba(255,255,255,0.08)',
    edge: 'rgba(255,255,255,0.16)',
    card: 'rgba(255,255,255,0.07)',
    bar: 'rgba(255,255,255,0.14)',
    bar2: 'rgba(255,255,255,0.09)',
} as const;

const smooth = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
/** Back-out: overshoots about 13% and settles. The playful landing of every move and pop (owner: bouncy). */
const bouncy = (u: number) => 1 + 3 * (u - 1) ** 3 + 2 * (u - 1) ** 2;
/** A small settle (about 3%) for moves: a long move with a 13% overshoot lands visibly off target. */
const settle = (u: number) => 1 + 1.6 * (u - 1) ** 3 + 0.6 * (u - 1) ** 2;
const SAMPLES = [0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1];

/** Eased keyframes as an interpolation of the clock (or the constant itself). `pop` overshoots 13% (scales), `settle` 3% (moves); `min` floors it (a scale never flips). */
export function kf(t: Clock, keys: Keys, ease_: 'smooth' | 'settle' | 'pop' | boolean = 'smooth', min = -Infinity): Num {
    if (keys.length === 1) return keys[0][1];
    const ease = ease_ === 'pop' || ease_ === true ? bouncy : ease_ === 'settle' ? settle : smooth;
    const inputRange: number[] = [keys[0][0]];
    const outputRange: number[] = [keys[0][1]];
    for (let i = 1; i < keys.length; i++) {
        const [pm, pv] = keys[i - 1];
        const [m, v] = keys[i];
        for (const u of SAMPLES) {
            inputRange.push(pm + (m - pm) * u);
            outputRange.push(Math.max(min, pv + (v - pv) * ease(u)));
        }
    }
    return t.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}

/** Opacity that is 0 before `a`, fades in over `fi`, holds, and fades out by `b` (Infinity = stays). */
export function life(a: number, b = Infinity, fi = 250, fo = 250): Keys {
    if (a <= 0 && b === Infinity) return [[0, 1]];
    const k: [number, number][] = a <= 0 ? [[0, 1]] : [[a - 1, 0], [a, 0], [a + fi, 1]];
    if (b !== Infinity) k.push([b - fo, 1], [b, 0]);
    return k;
}

interface ObjProps {
    readonly t: Clock;
    /** Top-left on the stage, keyed. */
    readonly x: Keys;
    readonly y: Keys;
    readonly s?: Keys;
    readonly o?: Keys;
    /** Static rotation in degrees. */
    readonly rot?: number;
    readonly w?: number;
    readonly h?: number;
    readonly style?: StyleProp<ViewStyle>;
    readonly children?: React.ReactNode;
}

/** One object on the stage. Scale is about its centre. */
export const Obj: React.FC<ObjProps> = ({ t, x, y, s = [[0, 1]], o = [[0, 1]], rot = 0, w, h, style, children }) => (
    <Animated.View
        pointerEvents="none"
        style={[
            { position: 'absolute', left: 0, top: 0, width: w, height: h, opacity: kf(t, o) },
            { transform: [{ translateX: kf(t, x, 'settle') }, { translateY: kf(t, y, 'settle') }, { scale: kf(t, s, 'pop', 0.001) }, { rotate: `${rot}deg` }] },
            style,
        ]}
    >
        {children}
    </Animated.View>
);

/** A thin line from (x1,y1) to (x2,y2) that draws itself in from its start over [a, a+dur]. */
export const Line: React.FC<{ t: Clock; x1: number; y1: number; x2: number; y2: number; a: number; dur?: number; o?: Keys; color: string; width?: number }> = ({
    t, x1, y1, x2, y2, a, dur = 300, o, color, width = 3,
}) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const grow = kf(t, [[a, 0.001], [a + dur, 1]]);
    return (
        <Animated.View
            pointerEvents="none"
            style={{
                position: 'absolute',
                left: (x1 + x2) / 2 - len / 2,
                top: (y1 + y2) / 2 - width / 2,
                width: len,
                height: width,
                backgroundColor: color,
                opacity: kf(t, o ?? life(a, Infinity, 1)),
                transform: [{ rotate: `${ang}deg` }, { translateX: -len / 2 }, { scaleX: grow }, { translateX: len / 2 }],
            }}
        />
    );
};

/** Text with one accented run, written `plain <a>accent</a> plain` in the dictionaries. */
export const Accented: React.FC<{ text: string; style: StyleProp<TextStyle> }> = ({ text, style }) => {
    const parts = text.split(/<a>|<\/a>/);
    return (
        <Text allowFontScaling={false} style={style}>
            {parts.map((p, i) => (i % 2 ? <Text key={i} style={{ color: C.accent }}>{p}</Text> : p))}
        </Text>
    );
};

export const Icon: React.FC<{ name: IconName; size: number; color?: string; flip?: boolean }> = ({ name, size, color = C.ink2, flip }) => (
    <MaterialIcons name={name} size={size} color={color} style={flip ? { transform: [{ scaleX: -1 }] } : undefined} />
);

/** Pill with an icon. `tone`: plain, accent (a fact, brighter glass), topic (dashed, a thing to look for). Neutral by design: orange is kept for the one thing that matters in each moment (owner). */
export const Chip: React.FC<{ icon?: IconName; label: string; tone?: 'plain' | 'accent' | 'topic'; size?: number; strike?: boolean }> = ({
    icon, label, tone = 'plain', size = 34, strike = false,
}) => (
    <View style={[s.chip, { height: size * 2.5, paddingHorizontal: size * 0.95, gap: size * 0.4, borderRadius: size * 1.25 }, tone === 'accent' && s.chipAccent, tone === 'topic' && s.chipTopic]}>
        {icon ? <Icon name={icon} size={size * 1.15} color={tone === 'topic' ? C.ink3 : C.ink2} /> : null}
        <Text allowFontScaling={false} numberOfLines={1} style={[s.chipLabel, { fontSize: size }, strike && s.strike]}>{label}</Text>
    </View>
);

/** A skeleton news card: avatar letter, optional source label, country code or word chip, optional headline. */
export const NewsCard: React.FC<{ w: number; letter: string; source?: string; cc?: string; rel?: string; relTone?: 'high' | 'med'; headline?: string; lit?: boolean; scale?: number }> = ({
    w, letter, source, cc, rel, relTone = 'high', headline, lit = false, scale = 1,
}) => {
    const k = scale;
    return (
        <View style={[s.card, { width: w, padding: 24 * k, borderRadius: 30 * k }, lit && s.cardLit]}>
            <View style={[s.row, { gap: 12 * k }]}>
                <View style={[s.av, { width: 38 * k, height: 38 * k, borderRadius: 19 * k }]}><Text allowFontScaling={false} style={[s.avText, { fontSize: 20 * k }]}>{letter}</Text></View>
                {source ? <Text allowFontScaling={false} numberOfLines={1} style={[s.source, { fontSize: 22 * k }]}>{source}</Text> : <View style={[s.barInline, { width: 110 * k, height: 12 * k }]} />}
                <View style={{ flex: 1 }} />
                {rel ? <View style={[s.rel, relTone === 'med' && s.relMed, { paddingHorizontal: 16 * k, paddingVertical: 6 * k }]}><Text allowFontScaling={false} style={[s.relText, relTone === 'med' && s.relTextMed, { fontSize: 21 * k }]}>{rel}</Text></View> : null}
                {cc ? <View style={[s.cc, { paddingHorizontal: 10 * k, paddingVertical: 4 * k }]}><Text allowFontScaling={false} style={[s.ccText, { fontSize: 19 * k }]}>{cc}</Text></View> : null}
            </View>
            {headline ? (
                <Text allowFontScaling={false} style={[s.headline, { fontSize: 28 * k, lineHeight: 36 * k, marginTop: 14 * k }]}>{headline}</Text>
            ) : (
                <>
                    <View style={[s.bar, { height: 15 * k, marginTop: 16 * k }]} />
                    <View style={[s.bar, s.barShort, { height: 15 * k, marginTop: 16 * k }]} />
                </>
            )}
        </View>
    );
};

export const Phone: React.FC<{ w: number; h: number; ring?: boolean; children?: React.ReactNode; style?: StyleProp<ViewStyle> }> = ({ w, h, ring, children, style }) => (
    <View style={[s.phone, { width: w, height: h }, ring && s.phoneRing, style]}>{children}</View>
);

/** The finger: a ring that presses at `at`. */
export const Tap: React.FC<{ t: Clock; x: number; y: number; at: number; out?: number }> = ({ t, x, y, at, out = Infinity }) => (
    <Obj t={t} x={[[0, x]]} y={[[0, y]]} o={life(at - 200, out, 200)} s={[[at, 1], [at + 150, 0.78], [at + 300, 1]]}>
        <View style={s.tap} />
    </Obj>
);

/** Soft static glows on black (the design system's static backdrop), from stacked faint rings. */
export const Backdrop: React.FC = () => (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {GLOWS.map((g) => (
            <View key={g.key} style={{ position: 'absolute', left: g.x - g.r, top: g.y - g.r, width: g.r * 2, height: g.r * 2, borderRadius: g.r, backgroundColor: g.color }} />
        ))}
    </View>
);
const rings = (key: string, x: number, y: number, from: number, rgb: string, alpha: number) =>
    Array.from({ length: 16 }, (_, i) => from - i * (from / 18)).map((r) => ({ key: `${key}${r}`, x, y, r, color: `rgba(${rgb},${alpha})` }));
const GLOWS = [...rings('w', 990, 210, 780, '231,138,83', 0.012), ...rings('b', 60, 1920, 840, '56,112,170', 0.014)];

export const s = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center' },
    chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)', backgroundColor: '#1c1c1f' },
    chipAccent: { backgroundColor: '#26262a', borderColor: 'rgba(255,255,255,0.28)' },
    chipTopic: { backgroundColor: 'rgba(0,0,0,0.6)', borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.32)' },
    chipLabel: { color: C.ink, fontWeight: '600' },
    strike: { textDecorationLine: 'line-through', color: C.ink3 },
    card: { backgroundColor: C.card, borderWidth: 2, borderColor: 'rgba(255,255,255,0.1)' },
    cardLit: { borderColor: 'rgba(255,255,255,0.32)', backgroundColor: 'rgba(255,255,255,0.11)' },
    av: { backgroundColor: '#303034', alignItems: 'center', justifyContent: 'center' },
    avText: { color: C.ink, fontWeight: '700' },
    source: { color: C.ink2, fontWeight: '600', flexShrink: 1 },
    cc: { borderRadius: 999, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.2)', marginLeft: 8 },
    ccText: { color: C.ink2, fontWeight: '600' },
    rel: { borderRadius: 999, backgroundColor: '#FCE3CF' },
    relMed: { backgroundColor: '#E6EEF8' },
    relText: { color: '#5a2d10', fontWeight: '700' },
    relTextMed: { color: '#22344d' },
    headline: { color: C.ink, fontWeight: '700' },
    bar: { borderRadius: 8, backgroundColor: C.bar },
    barShort: { width: '58%', backgroundColor: C.bar2 },
    barInline: { borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.2)' },
    phone: { borderRadius: 64, borderWidth: 3, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: '#0c0c0e', overflow: 'hidden' },
    phoneRing: { borderColor: C.accent, borderWidth: 6 },
    tap: { width: 96, height: 96, borderRadius: 48, borderWidth: 5, borderColor: C.ink, backgroundColor: 'rgba(255,255,255,0.3)' },
});
