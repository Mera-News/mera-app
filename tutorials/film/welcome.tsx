// The welcome film: one continuous shot, ELI10, played start to finish, the
// same film in the app and as an exported video. Owner rules: a welcome video
// with an ad's energy (bouncy, playful); reference objects, never real UI; show
// one thing slowly, then the same at scale; every scene change is a morph; it
// ends on the Mera mark alone. Layout is the canvas board's, on a 1080x1920 stage.
// Imports limited as in stage.tsx.

import React from 'react';
import { Animated, Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Mask, Path, Pattern, Rect, Stop } from 'react-native-svg';

import { Accented, Backdrop, C, Chip, Icon, Line, NewsCard, Obj, Phone, STAGE, kf, life, type Clock, type IconName, type Keys } from './stage';
import { Globe } from './globe';
import { startOf, type WelcomeCopy } from './welcome-script';

const T = {
    you: startOf('you'), tell: startOf('tell'), becomes: startOf('becomes'),
    haystack: startOf('haystack'), picks: startOf('picks'), reads: startOf('reads'), foryou: startOf('foryou'),
    notes: startOf('notes'), private: startOf('private'), logo: startOf('logo'),
};

const at = (x: number): Keys => [[0, x]];

// ── Scene 1 · noise ─────────────────────────────────────────────────────────
// A generic social feed (no real app's name, logo or layout): endless scroll,
// angry reactions, misinformation and rage badges, a screen-time pill.
const SOCIAL = { x: 190, y: 480, w: 700, h: 1300 };
const SOCIAL_RUN = 3000;
type PostBadge = 'fake' | 'rage' | null;
const POSTS: { hue: string; icon: IconName; badge: PostBadge; react: string; count: string }[] = [
    { hue: '#3a2420', icon: 'campaign', badge: 'rage', react: '😡🤬', count: '12k' },
    { hue: '#202a3a', icon: 'warning', badge: 'fake', react: '😱💀', count: '8.4k' },
    { hue: '#2c203a', icon: 'whatshot', badge: 'rage', react: '😤😡', count: '31k' },
    { hue: '#203a2e', icon: 'trending-up', badge: 'fake', react: '🙄😱', count: '5.2k' },
    { hue: '#3a3320', icon: 'campaign', badge: null, react: '😡😠', count: '19k' },
    { hue: '#3a2030', icon: 'warning', badge: 'fake', react: '💀🤬', count: '44k' },
    { hue: '#20343a', icon: 'whatshot', badge: 'rage', react: '😱😡', count: '9.9k' },
    { hue: '#2a2a2a', icon: 'campaign', badge: 'fake', react: '🙄😤', count: '27k' },
];
const EMOJI = ['😡', '🤬', '😱', '💀', '🙄', '😤', '😠', '🔥'];
/** Reactions bubbling up the right of the feed, a new one every 200 ms. */
const BUBBLES = Array.from({ length: 16 }, (_, i) => ({ i, e: EMOJI[i % EMOJI.length], x: 780 + ((i * 53) % 160), a: 200 + i * 200 }));
const PILL_SPOTS = [[40, 640, -6], [600, 860, 5], [30, 1200, -4], [640, 1420, 6]] as const;
const PILL_IDS = ['trending', 'fake', 'screenTime', 'rage'] as const;
const PILL_ICONS: IconName[] = ['local-fire-department', 'report', 'hourglass-bottom', 'mood-bad'];

const SocialPost: React.FC<{ p: (typeof POSTS)[number] }> = ({ p }) => (
    <View style={st.post}>
        <View style={[st.rowC, st.postHead]}>
            <View style={[st.postAv, { backgroundColor: p.hue }]} />
            <View style={st.postHandle} />
            <View style={st.flex} />
            <Icon name="more-horiz" size={36} color={C.ink2} />
        </View>
        <View style={[st.postImage, { backgroundColor: p.hue }]}>
            <Icon name={p.icon} size={150} color="rgba(255,255,255,0.35)" />
            {p.badge === 'fake' ? <View style={[st.postBadge, st.badgeFake]}><Icon name="report" size={52} color={C.ink} /></View> : null}
            {p.badge === 'rage' ? <View style={[st.postBadge, st.badgeRage]}><Icon name="local-fire-department" size={52} color={C.ink} /></View> : null}
        </View>
        <View style={[st.rowC, st.postActions]}>
            <Icon name="favorite-border" size={44} color={C.ink} />
            <Icon name="chat-bubble-outline" size={42} color={C.ink} />
            <Icon name="send" size={42} color={C.ink} />
            <View style={st.flex} />
            <Text allowFontScaling={false} style={st.postReact}>{p.react} {p.count}</Text>
        </View>
        <View style={st.postBar} />
        <View style={[st.postBar, st.postBarShort]} />
    </View>
);

// ── Scene 2-3 · facts and topics ────────────────────────────────────────────
type FactId = keyof WelcomeCopy['fact'];
type TopicId = keyof WelcomeCopy['topic'];
const FACTS: { id: FactId; icon: IconName; topics: TopicId[] }[] = [
    { id: 'nurse', icon: 'medical-services', topics: ['nursePay', 'staffing', 'nightShift'] },
    { id: 'utrecht', icon: 'home', topics: ['housing', 'council'] },
    { id: 'kids', icon: 'school', topics: ['holidays'] },
    { id: 'cycle', icon: 'directions-bike', topics: ['bikeLanes', 'railStrikes'] },
    { id: 'psv', icon: 'sports-soccer', topics: ['eredivisie'] },
    { id: 'spanish', icon: 'translate', topics: ['languageApps'] },
    { id: 'rent', icon: 'key', topics: ['rentRules', 'energyBills'] },
    { id: 'funds', icon: 'savings', topics: ['interestRates'] },
    { id: 'porto', icon: 'flight', topics: ['portoFlights'] },
    { id: 'veg', icon: 'eco', topics: ['foodPrices'] },
    { id: 'piano', icon: 'piano', topics: ['concerts'] },
    { id: 'japan', icon: 'luggage', topics: ['japanTravel', 'yenRate'] },
];
/** Scene 2 orbit spots (top-left) for the first four facts. */
const ORBIT = [[80, 780], [560, 640], [80, 1360], [540, 1470]] as const;
/** The profile web: centres of the twelve facts around the hub. */
const HUB = [540, 1080] as const;
const SPOTS = [[300, 720], [780, 720], [170, 850], [540, 850], [910, 850], [260, 990], [820, 990], [260, 1170], [820, 1170], [170, 1310], [910, 1310], [540, 1440]] as const;
/** When each fact joins the web: one slow, then faster and faster. */
const FACT_AT = [0, 300, 900, 1200, 1500, 1650, 1800, 1950, 2100, 2200, 2300, 2400].map((d) => T.becomes + d);
const topicSpot = (i: number, j: number, n: number) => {
    const [fx, fy] = SPOTS[i];
    const dx = fx - HUB[0], dy = fy - HUB[1], d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
    const off = (j - (n - 1) / 2) * 150;
    return [fx + ux * 150 - uy * off, fy + uy * 110 + ux * off * 0.3] as const;
};
/** A centred box, so an object of unknown width sits on a centre point. */
const BOX_W = 440, BOX_H = 90;

// ── Scene 4 · haystack ──────────────────────────────────────────────────────
const WALL_Y = 560;
const GLOBE_R = 500;
const cellXY = (col: number, row: number) => [col * 18 + 1, WALL_Y + row * 14 + 1] as const;
/** While it fetches, the profile web rests over the grid at this scale about the stage centre. */
const WEB_S = 0.5;
const onWeb = (x: number, y: number) => [540 + (x - 540) * WEB_S, 960 + (y - 960) * WEB_S] as const;
const TOPIC_NODES = FACTS.flatMap((f, i) => f.topics.map((_, j) => onWeb(...topicSpot(i, j, f.topics.length))));
/** The clear ring round the profile: no beam and no lit block lands inside it (owner: beams go outwards). */
const HUB_ON = onWeb(HUB[0], HUB[1]);
const FREE_R = 270;
const snapCell = (x: number, y: number) =>
    cellXY(Math.min(59, Math.max(0, Math.round((x - 1) / 18))), Math.min(69, Math.max(0, Math.round((y - WALL_Y - 1) / 14))));
const outsideRing = (x: number, y: number) => Math.hypot(x - HUB_ON[0], y - HUB_ON[1]) > FREE_R;
/** Beams run from a topic node outwards, away from the profile, to a block beyond it; they start as soon as the web has shrunk, faster and faster. */
const BEAM_A = T.haystack + 1700, BEAM_SPAN = T.reads - 400 - BEAM_A;
const BEAMS = (() => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    return Array.from({ length: 48 }, (_, k) => {
        const [nx, ny] = TOPIC_NODES[(k * 7) % TOPIC_NODES.length];
        const dx = nx - HUB_ON[0], dy = ny - HUB_ON[1], d = Math.hypot(dx, dy) || 1;
        const ux = dx / d, uy = dy / d;
        const reach = 140 + rnd() * 360, side = (rnd() - 0.5) * 240;
        let [x, y] = snapCell(nx + ux * reach - uy * side, ny + uy * reach + ux * side);
        for (let push = 40; !outsideRing(x, y) && push < 600; push += 40) [x, y] = snapCell(nx + ux * (reach + push), ny + uy * (reach + push));
        return { k, x, y, nx, ny, a: BEAM_A + BEAM_SPAN * Math.sqrt(k / 48) };
    });
})();
/** Every story a beam picks flies up into this tray under the caption, one block each, in order. */
const traySlot = (k: number) => [62 + (k % 24) * 40, k < 24 ? 476 : 504] as const;
/** More blocks light with no beam drawn, quicker and quicker, all outside the ring: the haul is far bigger than the beams. */
const GLOW = (() => {
    let seed = 13;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const out: { k: number; x: number; y: number; a: number }[] = [];
    while (out.length < 140) {
        const [x, y] = cellXY(Math.floor(rnd() * 60), Math.floor(rnd() * 70));
        if (outsideRing(x, y)) out.push({ k: out.length, x, y, a: BEAM_A + 900 + (BEAM_SPAN - 900) * Math.sqrt(out.length / 140) });
    }
    return out;
})();

// ── Scene 5 · reading: the first five tray blocks become five cards, read one by one ──
type MiscId = keyof WelcomeCopy['misc'];
const READ: { letter: string; source: MiscId; cc: string; keep?: 'high' | 'med' }[] = [
    { letter: 'H', source: 'healthDesk', cc: 'NL', keep: 'high' },
    { letter: 'C', source: 'celebNews', cc: 'US' },
    { letter: 'U', source: 'cityNews', cc: 'NL', keep: 'high' },
    { letter: 'M', source: 'markets', cc: 'JP' },
    { letter: 'E', source: 'education', cc: 'NL', keep: 'med' },
];
const READ_X = 350;
const READ_Y = [600, 790, 980, 1170, 1360];
const KEPT = [0, 2, 4];
/** The five tray blocks swoop down one after another and become the cards. */
const morphAt = (k: number) => T.reads + 200 + k * 140;
const decideAt = (i: number) => T.reads + 1500 + i * 550;
const SCAN_STEPS: [number, number][] = READ_Y.flatMap((y, i) => [[decideAt(i) - 300, y + 74], [decideAt(i) - 200, y + 74]] as [number, number][]);

// ── Scene 6 · notes: the kept cards become the first notes; more follow, faster ──
const GRID = ['H', 'U', 'E', 'N', 'S', 'C', 'T', 'R'];
const GRID_REL = ['high', 'high', 'med', 'high', 'med', 'med', 'high', 'med'] as const;
const GRID_AT = [250, 250, 250, 900, 1200, 1400, 1520, 1600].map((d) => T.notes + d);
const NOTE_AT = [700, 950, 1150, 1050, 1350, 1520, 1620, 1700].map((d) => T.notes + d);
const gridXY = (i: number) => [70 + (i % 2) * 490, 600 + Math.floor(i / 2) * 242] as const;

/** When each notes card leaves the grid and drops into the For You phone, quicker and quicker. */
const dropAt = (i: number) => T.foryou + 150 + Math.round(900 * Math.sqrt(i / 8));

// ── Scene 7 · private ───────────────────────────────────────────────────────
/** The same phone as the fast feed's (440x880, centre 540,1080), so one hands over to the other with no second outline. */
const PHONE7 = { x: 320, y: 640, w: 440, h: 880 };
/** The phone sits small at the centre; the padlock body wraps it and the shackle clicks shut at CLICK. */
const LOCK = { x: 380, y: 797, w: 320, h: 460 };
const CLICK = T.private + 1800;
/** Drops the padlock (drawn round the stage centre, then scaled 0.8) into the lower third, clear of the chips. */
const LOCK_DY = 620;
/** Promo end card: two full-size phones side by side, the official badges under them (height 110). */
const PROMO_Y = 400;
const PROMO_L = 80;
const PROMO_R = 560;
const BADGE_H = 110;
const BADGES_W = BADGE_H * (119.66 / 40) + 30 + BADGE_H * (180 / 53.33);
/** The nurse's three topics sit under the facts inside the locked phone. */
/** The screenshot phones take the captures' own shape (349x760), so `cover` trims nothing. */
const SHOT = { x: PHONE7.x, y: PHONE7.y - 39, w: PHONE7.w, h: Math.round((PHONE7.w * 760) / 349) };
const phoneTopicY = (j: number) => PHONE7.y + 70 + 3 * 72 + 50 + j * 62;
const LOCKED_FACTS: FactId[] = ['nurse', 'utrecht', 'kids'];

/** The Mera mark (the same drawing as the guide videos' end card). */
const MeraMark: React.FC<{ t: Clock }> = ({ t }) => (
    <View>
    <Animated.View style={[StyleSheet.absoluteFill, st.beam, { transform: [{ rotate: t.interpolate({ inputRange: [T.logo, T.logo + 1500, T.logo + 3000, T.logo + 4200], outputRange: ['-15deg', '15deg', '-10deg', '0deg'], extrapolate: 'clamp' }) }] }]}>
        <Svg width={280} height={400} viewBox="255 146 514 732" fill="none"><Path d="M512 760 L450 485 L574 485 Z" fill={C.ink} opacity={0.3} /></Svg>
    </Animated.View>
    <Svg width={280} height={400} viewBox="255 146 514 732" fill="none">
        <Path d="M512 170 L745 304 L745 720 L512 854 L279 720 L279 304 Z" stroke={C.ink} strokeWidth={24} strokeLinejoin="round" />
        <G stroke={C.ink} strokeOpacity={0.18} strokeWidth={10}>
            <Rect x={320} y={330} width={150} height={110} rx={14} /><Rect x={490} y={330} width={150} height={110} rx={14} />
            <Rect x={320} y={465} width={150} height={110} rx={14} /><Rect x={320} y={600} width={150} height={110} rx={14} />
            <Rect x={490} y={600} width={150} height={110} rx={14} />
        </G>
        <Rect x={490} y={465} width={150} height={110} rx={14} stroke={C.accent} strokeWidth={16} />
        <Circle cx={512} cy={748} r={16} fill={C.ink} />
    </Svg>
    </View>
);

export interface WelcomeFilmProps {
    readonly t: Clock;
    readonly copy: WelcomeCopy;
    /** Right-aligns the captions; the stage itself always lays out left to right. */
    readonly rtl?: boolean;
    /** The real For You screen in the viewer's language (`shots/index.ts`): a bundled asset, or a URL in the export. */
    readonly feedShot?: number | string;
    /** The promo cut (export only): the ending shows the app beside its chat, the line and the store badges instead of the mark. */
    readonly promo?: WelcomePromo;
}

export interface WelcomePromo {
    readonly chatShot: number | string;
    readonly appStore: string;
    readonly googlePlay: string;
    /** Accented like a caption, e.g. `Start <a>for free</a>.` */
    readonly line: string;
}

const src = (x: number | string) => (typeof x === 'string' ? { uri: x } : x);

const Caption: React.FC<{ t: Clock; text: string; a: number; b?: number; sub?: string; rtl?: boolean }> = ({ t, text, a, b = Infinity, sub, rtl }) => (
    <Obj t={t} x={at(96)} y={a <= 0 ? at(170) : [[a, 200], [a + 400, 170]]} o={life(a, b)} w={STAGE.width - 96 - 150}>
        <Accented text={text} style={[st.cap, visualLength(text) > 70 && st.capLong, rtl && st.capRtl]} />
        {sub ? <Text allowFontScaling={false} style={st.sub}>{sub}</Text> : null}
    </Obj>
);

/** Caption length as it takes space: a CJK character is about two Latin ones wide. */
const visualLength = (text: string) => text.length + (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0);

/** The first fact, with the ring that draws round it and the finger that taps it, both sized by the chip itself. */
const FocusChip: React.FC<{ t: Clock; icon: IconName; label: string }> = ({ t, icon, label }) => (
    <View>
        <Chip icon={icon} label={label} tone="accent" />
        <Animated.View pointerEvents="none" style={[st.chipRing, { opacity: kf(t, life(T.tell + 600, T.becomes + 200)) }]} />
        <Animated.View pointerEvents="none" style={[st.chipTap, { opacity: kf(t, life(T.tell + 700, T.tell + 2100, 200)), transform: [{ scale: kf(t, [[T.tell + 900, 1], [T.tell + 1050, 0.78], [T.tell + 1200, 1]]) }] }]} />
    </View>
);

/** A web node: its labelled chip until the web shrinks over the grid, then a plain dot (owner: no text once small). */
const WebNode: React.FC<{ t: Clock; dot: number; color: string; children?: React.ReactNode }> = ({ t, dot, color, children }) => (
    <>
        {children ? <Animated.View style={{ opacity: kf(t, [[T.haystack, 1], [T.haystack + 500, 0]]) }}>{children}</Animated.View> : null}
        <Animated.View pointerEvents="none" style={[st.webDot, { width: dot, height: dot, borderRadius: dot / 2, marginLeft: -dot / 2, marginTop: -dot / 2, backgroundColor: color, opacity: kf(t, [[T.haystack + 100, 0], [T.haystack + 600, 1]]) }]} />
    </>
);

/** A thing on a centre point, keyed; its own width can be anything up to BOX_W. */
const Centred: React.FC<{ t: Clock; cx: Keys; cy: Keys; s?: Keys; o?: Keys; children: React.ReactNode }> = ({ t, cx, cy, s, o, children }) => (
    <Obj t={t} w={BOX_W} h={BOX_H} x={cx.map(([m, v]) => [m, v - BOX_W / 2] as const)} y={cy.map(([m, v]) => [m, v - BOX_H / 2] as const)} s={s} o={o} style={st.centred}>
        {children}
    </Obj>
);

export const WelcomeFilm: React.FC<WelcomeFilmProps> = ({ t, copy, rtl = false, feedShot, promo }) => {
    const c = copy;
    const shot = feedShot === undefined ? undefined : src(feedShot);
    return (
        <View style={st.stage}>
            <Backdrop />

            {/* 1 · a social feed scrolling without end, shrinking into Mera's phone on the cut */}
            <Obj t={t} x={at(SOCIAL.x)} y={[[0, SOCIAL.y], [T.you, SOCIAL.y], [T.you + 600, 460]]} s={[[0, 1.08], [400, 1], [T.you, 1], [T.you + 600, 0.514]]} o={[[T.you + 200, 1], [T.you + 600, 0]]} w={SOCIAL.w} h={SOCIAL.h}>
                <Phone w={SOCIAL.w} h={SOCIAL.h}>
                    <Animated.View style={{ transform: [{ translateY: t.interpolate({ inputRange: [0, T.you + 600], outputRange: [0, -SOCIAL_RUN], extrapolate: 'clamp' }) }] }}>
                        <View style={[st.rowC, st.socialBar]}>
                            <View style={st.socialMark} />
                            <View style={st.flex} />
                            <Icon name="favorite-border" size={44} color={C.ink} />
                            <Icon name="send" size={42} color={C.ink} />
                        </View>
                        {POSTS.map((p, i) => <SocialPost key={i} p={p} />)}
                    </Animated.View>
                </Phone>
            </Obj>
            {BUBBLES.map((b) => (
                <Obj key={b.i} t={t} x={[[b.a, b.x], [b.a + 1400, b.x - 40]]} y={[[b.a, 1560], [b.a + 1400, 760]]} s={[[b.a, 0.3], [b.a + 300, 1]]} o={[[b.a - 1, 0], [b.a, 0], [b.a + 150, 1], [b.a + 1100, 1], [b.a + 1400, 0]]}>
                    <Text allowFontScaling={false} style={st.bubble}>{b.e}</Text>
                </Obj>
            ))}

            {/* 2 · Mera's phone takes the social phone's place */}
            <Obj t={t} x={[[T.you, 360], [T.tell, 360], [T.tell + 600, -420]]} y={at(760)} s={[[T.you, 1.94], [T.you + 600, 1]]} o={[[T.you - 1, 0], [T.you + 200, 0], [T.you + 600, 1], [T.tell, 1], [T.tell + 500, 0]]}>
                <Phone w={360} h={700} style={st.phone2}>
                    <View style={st.avatar}><Icon name="person" size={64} color={C.ink} /></View>
                    {[1, 0.6, 0.35].map((o, i) => <View key={i} style={[st.skel, { opacity: o }]}><View style={st.skelBar} /><View style={[st.skelBar, st.skelShort]} /></View>)}
                </Phone>
            </Obj>
            <Obj t={t} x={at(0)} y={at(0)} o={life(T.you + 200, T.tell + 300)} w={1080} h={1920}>
                <Svg width={1080} height={1920}>
                    <Ellipse cx={540} cy={1110} rx={440} ry={360} stroke="rgba(255,255,255,0.12)" strokeWidth={2} strokeDasharray="8 14" fill="none" />
                    <Ellipse cx={540} cy={1110} rx={330} ry={250} stroke="rgba(255,255,255,0.2)" strokeWidth={2} strokeDasharray="4 12" fill="none" />
                </Svg>
            </Obj>

            {/* 3a threads, under the chips */}
            {FACTS[0].topics.map((id, j) => {
                const a = T.tell + 1200 + j * 600;
                const ty = 842 + j * 160;
                return (
                    <React.Fragment key={id}>
                        <Line t={t} x1={200} y1={1002} x2={620} y2={ty} a={a - 300} color="rgba(255,255,255,0.55)" width={4} o={life(a - 300, T.becomes + 150, 1, 150)} />
                    </React.Fragment>
                );
            })}

            {/* noise pills pop on the beats, then morph into the first four facts */}
            {PILL_IDS.map((id, i) => {
                const [px, py, rot] = PILL_SPOTS[i];
                const [fx, fy] = ORBIT[i];
                const pop = 300 + i * 600;
                return (
                    <Obj key={id} t={t} x={[[0, px], [T.you, px], [T.you + 600, fx]]} y={[[0, py], [T.you, py], [T.you + 600, fy]]} o={[[pop - 1, 0], [pop, 0], [pop + 200, 1], [T.you, 1], [T.you + 200, 0]]} s={[[pop, 0.5], [pop + 300, 1]]} rot={rot}>
                        <Chip icon={PILL_ICONS[i]} label={c.pill[id]} />
                    </Obj>
                );
            })}
            {FACTS.slice(0, 4).map((f, i) => {
                const [px, py] = PILL_SPOTS[i];
                const [fx, fy] = ORBIT[i];
                const toX = i < 2 ? 70 : fx, toY = i === 0 ? 960 : i === 1 ? 1380 : fy + 120;
                const holdO = i === 0 ? 1 : i === 1 ? 0.35 : 0;
                // the faint Utrecht chip leaves before the padlock rises under it
                const goneAt = i === 0 ? T.becomes : i === 1 ? T.private : T.tell + 500;
                return (
                    <Obj key={f.id} t={t} x={[[T.you, px], [T.you + 600, fx], [T.tell, fx], [T.tell + 600, toX]]} y={[[T.you, py], [T.you + 600, fy], [T.you + 1200 + i * 150, fy - 14], [T.you + 2000 + i * 150, fy + 6], [T.tell, fy], [T.tell + 600, toY]]}
                        o={[[T.you + 200, 0], [T.you + 450, 1], [T.tell, 1], [T.tell + 500, holdO], [goneAt + 1, holdO], [goneAt + 400, 0]]} s={[[T.you + 200, 0.6], [T.you + 550, 1]]}>
                        {i === 0 ? <FocusChip t={t} icon={f.icon} label={c.fact[f.id]} /> : <Chip icon={f.icon} label={c.fact[f.id]} tone="accent" />}
                    </Obj>
                );
            })}

            {/* 3a · one fact, slowly: ring, tap, three threads, three topics */}
            {FACTS[0].topics.map((id, j) => {
                const ty = 842 + j * 160;
                const a = T.tell + 1200 + j * 600;
                const [wx, wy] = topicSpot(0, j, 3);
                return (
                    <React.Fragment key={id}>
                        <Centred t={t} cx={[[a, 820], [T.becomes, 820], [T.becomes + 600, wx]]} cy={[[a, ty], [T.becomes, ty], [T.becomes + 600, wy]]} s={[[a, 0.8], [a + 200, 1], [T.becomes, 1], [T.becomes + 600, 0.55]]} o={[[a - 1, 0], [a, 0], [a + 200, 1], [T.haystack, 1], [T.haystack + 400, 0]]}>
                            <Chip icon="search" label={c.topic[id]} tone="topic" size={30} />
                        </Centred>
                    </React.Fragment>
                );
            })}

            {/* 4a · a faded Earth turns behind the grid: the stories come from the whole world */}
            <Obj t={t} x={at(0)} y={at(0)} w={1080} h={1920} o={[[T.haystack + 300, 0], [T.haystack + 900, 0.42], [T.reads + 200, 0.42], [T.reads + 600, 0]]} s={[[T.haystack + 300, 1.6], [T.haystack + 2000, 1]]}>
                <View style={st.globe}>
                    <Globe t={t} r={GLOBE_R} a={T.haystack} b={T.reads + 600} from={-30} to={50} />
                </View>
            </Obj>

            {/* 4a · the grid of the day's stories opens under the profile */}
            <Obj t={t} x={at(0)} y={at(0)} w={1080} h={1920} o={[[T.haystack + 300, 0], [T.haystack + 700, 1], [T.reads + 200, 1], [T.reads + 600, 0]]} s={[[T.haystack + 300, 1.6], [T.haystack + 2000, 1]]}>
                <Animated.View style={[st.wall, { opacity: kf(t, [[T.picks, 1], [T.picks + 600, 0.55]]) }]}>
                    <Svg width={1080} height={1000}>
                        <Defs>
                            <Pattern id="cells" width={18} height={14} patternUnits="userSpaceOnUse"><Rect x={1} y={1} width={15} height={11} rx={2.5} fill="rgba(255,255,255,0.13)" /></Pattern>
                            <LinearGradient id="wallFade" x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor="#fff" stopOpacity="0" /><Stop offset="0.12" stopColor="#fff" stopOpacity="1" />
                                <Stop offset="0.82" stopColor="#fff" stopOpacity="1" /><Stop offset="1" stopColor="#fff" stopOpacity="0" />
                            </LinearGradient>
                            <Mask id="wallMask"><Rect width={1080} height={1000} fill="url(#wallFade)" /></Mask>
                        </Defs>
                        <Rect width={1080} height={1000} fill="url(#cells)" mask="url(#wallMask)" />
                    </Svg>
                </Animated.View>
                {GLOW.map((g) => (
                    <Obj key={`g${g.k}`} t={t} x={at(g.x)} y={at(g.y)} o={life(g.a, Infinity, 150)}><View style={[st.cell, st.cellDim]} /></Obj>
                ))}
                {BEAMS.map((b) => (
                    <Obj key={`b${b.k}`} t={t} x={at(b.x)} y={at(b.y)} s={[[b.a + 220, 1.8], [b.a + 450, 1]]} o={[[b.a + 219, 0], [b.a + 220, 1]]}>
                        <View style={st.cell} />
                    </Obj>
                ))}
            </Obj>
            {/* 4b · beams from the profile's topics reach into the grid and light what they fetch */}
            {BEAMS.map((b) => (
                <Line key={b.k} t={t} x1={b.nx} y1={b.ny} x2={b.x + 7.5} y2={b.y + 5.5} a={b.a} dur={220} color="rgba(231,138,83,0.85)" width={3} o={[[b.a - 1, 0], [b.a, 0], [b.a + 1, 0.9], [b.a + 500, 0.9], [b.a + 800, 0]]} />
            ))}

            {/* 3b · the rest of the profile, faster and faster; then it shrinks into an overlay on the grid */}
            <Obj t={t} x={at(0)} y={at(0)} w={1080} h={1920} s={[[T.becomes, 1.25], [T.becomes + 2800, 1], [T.haystack, 0.95], [T.haystack + 1600, WEB_S + 0.02], [T.picks, WEB_S]]} o={[[T.reads, 1], [T.reads + 400, 0]]}>
                {FACTS.map((f, i) => {
                    const [fx, fy] = SPOTS[i];
                    const a = FACT_AT[i];
                    return (
                        <React.Fragment key={f.id}>
                            <Line t={t} x1={HUB[0]} y1={HUB[1]} x2={fx} y2={fy} a={a} dur={200} color="rgba(255,255,255,0.35)" width={2} />
                            {f.topics.map((id, j) => {
                                const [tx, ty] = topicSpot(i, j, f.topics.length);
                                const ta = a + 150 + j * 80;
                                return (
                                    <React.Fragment key={id}>
                                        <Line t={t} x1={fx} y1={fy} x2={tx} y2={ty} a={ta} dur={150} color="rgba(255,255,255,0.18)" width={2} />
                                        {i > 0 ? (
                                            <Centred t={t} cx={at(tx)} cy={at(ty)} s={[[ta, 0.3], [ta + 150, 0.55]]} o={life(ta, Infinity, 150)}>
                                                <WebNode t={t} dot={40} color={C.accent}><Chip icon="search" label={c.topic[id]} tone="topic" size={30} /></WebNode>
                                            </Centred>
                                        ) : (
                                            <Centred t={t} cx={at(tx)} cy={at(ty)} s={at(0.55)} o={life(T.haystack)}>
                                                <WebNode t={t} dot={40} color={C.accent} />
                                            </Centred>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                            <Centred t={t} cx={at(fx)} cy={at(fy)} s={[[a, 0.3], [a + 200, 0.62]]} o={life(i === 0 ? a + 300 : a, Infinity, 200)}>
                                <WebNode t={t} dot={64} color={C.ink}><Chip icon={f.icon} label={c.fact[f.id]} tone="accent" /></WebNode>
                            </Centred>
                        </React.Fragment>
                    );
                })}
                <Obj t={t} x={at(HUB[0] - 60)} y={at(HUB[1] - 60)} o={life(T.becomes + 100)} s={[[T.becomes + 100, 0.5], [T.becomes + 400, 1]]}>
                    <View style={st.hub}><Icon name="person" size={68} color={C.ink} /></View>
                </Obj>
            </Obj>

            {/* every picked story flies up into the tray under the caption */}
            {BEAMS.map((b) => {
                const [tx, ty] = traySlot(b.k);
                const picked = b.k < READ.length;
                return (
                    <Obj key={`tray${b.k}`} t={t} x={[[b.a + 250, b.x - 7], [b.a + 750, tx], ...(picked ? [[morphAt(b.k), tx], [morphAt(b.k) + 500, READ_X + 190 - 16]] as const : [])]} y={[[b.a + 250, b.y - 4], [b.a + 750, ty], ...(picked ? [[morphAt(b.k), ty], [morphAt(b.k) + 500, READ_Y[b.k] + 74 - 6.5]] as const : [])]} s={[[b.a + 250, 0.5], [b.a + 750, 1], ...(picked ? [[morphAt(b.k), 1], [morphAt(b.k) + 500, 380 / 32]] as const : [])]}
                        o={picked ? [[b.a + 249, 0], [b.a + 250, 1], [morphAt(b.k) + 150, 1], [morphAt(b.k) + 450, 0.45], [morphAt(b.k) + 600, 0]] : [[b.a + 249, 0], [b.a + 250, 1], [T.reads + 150, 1], [T.reads + 450, 0]]}>
                        <View style={st.trayBlock} />
                    </Obj>
                );
            })}

            {/* 5a · the first five tray blocks grow into five news cards; the scan steps one per beat */}
            {READ.map((r, i) => {
                const y = READ_Y[i];
                const d = decideAt(i);
                const keep = !!r.keep;
                const m = morphAt(i);
                const g = KEPT.indexOf(i);
                const [gx, gy] = g >= 0 ? gridXY(g) : [-400, y];
                return (
                    <React.Fragment key={i}>
                        <Obj t={t} x={[[m + 350, READ_X], [T.notes, READ_X], [T.notes + 500, gx + 225 - 190]]} y={[[m + 350, y], [T.notes, y], [T.notes + 500, gy + 105 - 74]]}
                            s={[[m + 350, 0.85], [m + 600, 1], [T.notes, 1], [T.notes + 500, g >= 0 ? 1.18 : 0.6]]}
                            o={[[m + 349, 0], [m + 350, 0], [m + 550, 1], [d, 1], [d + 200, keep ? 1 : 0.28], [T.notes, keep ? 1 : 0.28], [T.notes + (keep ? 450 : 300), 0]]}>
                            <NewsCard w={380} letter={r.letter} source={c.misc[r.source]} cc={r.cc} />
                        </Obj>
                        <Obj t={t} x={at(READ_X + 380 - 26)} y={at(y - 12)} o={life(d + 100, T.notes + 100, 150)}>
                            <Icon name={keep ? 'check-circle' : 'cancel'} size={44} color={keep ? C.done : C.ink3} />
                        </Obj>
                    </React.Fragment>
                );
            })}
            <Obj t={t} x={at(READ_X - 30)} y={SCAN_STEPS} o={life(T.reads + 1200, T.notes)} w={440} h={4} style={st.readScan} />

            {/* 6b · the notes drop into the real For You screen in the viewer's language; it holds, then folds into the logo */}
            <Obj t={t} x={promo ? [[T.logo, SHOT.x], [T.logo + 600, PROMO_L]] : at(SHOT.x)} y={promo ? [[T.logo, SHOT.y], [T.logo + 600, PROMO_Y]] : at(SHOT.y)} w={SHOT.w} h={SHOT.h}
                s={promo ? [[T.foryou, 1.12], [T.foryou + 450, 1]] : [[T.foryou, 1.12], [T.foryou + 450, 1], [T.logo, 1], [T.logo + 500, 0.5]]}
                o={promo ? life(T.foryou, Infinity, 300) : [[T.foryou - 1, 0], [T.foryou, 0], [T.foryou + 300, 1], [T.logo + 150, 1], [T.logo + 450, 0]]}>
                <Phone w={SHOT.w} h={SHOT.h} style={st.hollow}>
                    {shot ? (
                        <Obj t={t} x={at(0)} y={at(0)} w={SHOT.w} h={SHOT.h} o={life(dropAt(2), Infinity, dropAt(8) + 400 - dropAt(2))}>
                            <Image source={shot} style={st.shot} resizeMode="cover" />
                        </Obj>
                    ) : null}
                </Phone>
            </Obj>

            {/* 6a · the kept cards become the first notes; notes pop on more and more stories */}
            {GRID.map((letter, i) => {
                const [gx, gy] = gridXY(i);
                const a = GRID_AT[i];
                const rel = GRID_REL[i];
                return (
                    <Obj key={i} t={t} x={[[a, gx], [dropAt(i), gx], [dropAt(i) + 500, 540 - 225]]} y={[[a, gy], [dropAt(i), gy], [dropAt(i) + 500, 880 + (i % 4) * 40 - 105]]} s={[[a, i < 3 ? 1 : 0.8], [a + 200, 1], [dropAt(i), 1], [dropAt(i) + 500, 0.25]]}
                        o={[[a - 1, 0], [a, 0], [a + 200, 1], [dropAt(i) + 380, 1], [dropAt(i) + 500, 0]]} w={450} h={210}>
                        <View style={st.gridCard}>
                            <View style={[st.rowC, st.gap10]}>
                                <View style={st.gridAv}><Text allowFontScaling={false} style={st.gridAvText}>{letter}</Text></View>
                                <View style={st.gridSrc} />
                                <View style={st.flex} />
                                <View style={[st.gridRel, rel === 'med' && st.gridRelMed]}><Text allowFontScaling={false} style={[st.gridRelText, rel === 'med' && st.gridRelTextMed]}>{c.misc[rel]}</Text></View>
                            </View>
                            <View style={[st.gridBar, st.mt16]} />
                            <View style={[st.gridBar, st.gridBarShort]} />
                            <Animated.View style={[st.gridNote, { opacity: kf(t, life(NOTE_AT[i], Infinity, 150)), transform: [{ scale: kf(t, [[NOTE_AT[i], 0.6], [NOTE_AT[i] + 300, 1]], 'pop') }] }]}>
                                <Icon name="auto-awesome" size={24} color={C.accent} />
                                <View style={st.flex}><View style={st.gridNoteBar} /><View style={[st.gridNoteBar, st.gridNoteShort]} /></View>
                            </Animated.View>
                        </View>
                    </Obj>
                );
            })}

            {/* 7 · under the chips, a small phone holding the same facts and topics locks: it all stays on the phone */}
            <Obj t={t} x={at(0)} y={at(LOCK_DY)} w={1080} h={1920} s={at(0.8)} o={[[T.becomes - 300, 1], [T.becomes + 100, 0]]}>
                <Obj t={t} x={at(0)} y={at(0)} w={1080} h={1920} s={[[T.private, 0.38], [T.private + 450, 0.45]]} o={life(T.private + 100)}>
                    <Obj t={t} x={at(PHONE7.x)} y={at(PHONE7.y)}>
                        <Phone w={PHONE7.w} h={PHONE7.h} style={st.hollow} />
                    </Obj>
                    {LOCKED_FACTS.map((id, i) => (
                        <Obj key={id} t={t} x={at(PHONE7.x + 26)} y={at(PHONE7.y + 70 + i * 72)} o={life(T.private + 400 + i * 120, Infinity, 150)}>
                            <Chip icon={FACTS.find((f) => f.id === id)?.icon} label={c.fact[id]} tone="accent" size={24} />
                        </Obj>
                    ))}
                    {FACTS[0].topics.map((id, j) => (
                        <Centred key={id} t={t} cx={at(PHONE7.x + 220)} cy={at(phoneTopicY(j))} s={at(0.73)} o={life(T.private + 760 + j * 120, Infinity, 150)}>
                            <Chip icon="search" label={c.topic[id]} tone="topic" size={30} />
                        </Centred>
                    ))}
                </Obj>
                <Obj t={t} x={at(LOCK.x + LOCK.w / 2 - 110)} y={[[CLICK - 1000, LOCK.y - 280], [CLICK - 400, LOCK.y - 280], [CLICK, LOCK.y - 180]]} o={[[CLICK - 1000, 0], [CLICK - 700, 1], [T.becomes, 1], [T.becomes + 300, 0]]}>
                    <Svg width={220} height={210}><Path d="M 30 210 L 30 110 A 80 80 0 0 1 190 110 L 190 210" stroke={C.ink} strokeWidth={28} strokeLinecap="round" fill="none" /></Svg>
                </Obj>
                <Obj t={t} x={at(LOCK.x)} y={at(LOCK.y)} w={LOCK.w} h={LOCK.h} s={[[CLICK - 1100, 0.7], [CLICK - 700, 1], [CLICK, 1], [CLICK + 100, 1.06], [CLICK + 300, 1], [T.becomes, 1], [T.becomes + 300, 0.9]]} o={[[CLICK - 1100, 0], [CLICK - 800, 1], [T.becomes, 1], [T.becomes + 300, 0]]} style={st.lockBody} />
                <Obj t={t} x={at(540 - 300)} y={at(LOCK.y + LOCK.h / 2 - 300)} w={600} h={600} s={[[CLICK - 1, 0.5], [CLICK + 800, 1.25]]} o={[[CLICK - 1, 0], [CLICK, 0.6], [CLICK + 800, 0]]} style={st.pulse} />
                <Obj t={t} x={at(540 - 300)} y={at(LOCK.y + LOCK.h / 2 - 300)} w={600} h={600} s={[[CLICK + 999, 0.5], [CLICK + 1800, 1.25]]} o={[[CLICK + 999, 0], [CLICK + 1000, 0.35], [CLICK + 1800, 0]]} style={st.pulse} />
            </Obj>

            {promo ? (
                <>
                    {/* 8 · promo: the chat phone slides in beside the feed, then the store badges */}
                    <Obj t={t} x={[[T.logo + 150, STAGE.width + 40], [T.logo + 750, PROMO_R]]} y={at(PROMO_Y)} w={SHOT.w} h={SHOT.h} o={life(T.logo + 150, Infinity, 300)}>
                        <Phone w={SHOT.w} h={SHOT.h}>
                            <Image source={src(promo.chatShot)} style={st.shot} resizeMode="cover" />
                        </Phone>
                    </Obj>
                    <Obj t={t} x={at(540 - BADGES_W / 2)} y={[[T.logo + 800, 1500], [T.logo + 1200, 1450]]} o={life(T.logo + 800, Infinity, 300)} w={BADGES_W}>
                        <View style={st.badges}>
                            <Image source={{ uri: promo.appStore }} style={st.appStore} resizeMode="contain" />
                            <Image source={{ uri: promo.googlePlay }} style={st.googlePlay} resizeMode="contain" />
                        </View>
                    </Obj>
                </>
            ) : (
                // 8 · the For You phone folds into the Mera mark, which lands with a bounce and stays
                <Obj t={t} x={at(400)} y={[[T.logo, 1080 - 200], [T.logo + 700, 760]]} s={[[T.logo, 1.1], [T.logo + 700, 1], [T.logo + 1500, 1], [T.logo + 1700, 1.12], [T.logo + 2000, 1]]} o={[[T.logo + 99, 0], [T.logo + 100, 0], [T.logo + 400, 1]]} w={280} h={400}>
                    <MeraMark t={t} />
                </Obj>
            )}

            {/* captions: one place, the whole line swaps on the beat */}
            <Caption t={t} text={c.cap.noise} a={0} b={T.you} rtl={rtl} />
            <Caption t={t} text={c.cap.you} a={T.you} b={T.tell} rtl={rtl} />
            <Caption t={t} text={c.cap.tell} a={T.tell} b={T.private} rtl={rtl} />
            <Caption t={t} text={c.cap.becomes} a={T.becomes} b={T.haystack} rtl={rtl} />
            <Caption t={t} text={c.cap.haystack} a={T.haystack} b={T.picks} rtl={rtl} />
            <Caption t={t} text={c.cap.picks} a={T.picks} b={T.reads} rtl={rtl} />
            <Caption t={t} text={c.cap.reads} a={T.reads} b={T.notes} rtl={rtl} />
            <Caption t={t} text={c.cap.why} a={T.notes} b={T.logo} rtl={rtl} />
            {promo ? <Caption t={t} text={promo.line} a={T.logo + 300} rtl={rtl} /> : null}
            <Caption t={t} text={c.cap.private} a={T.private} b={T.becomes} rtl={rtl} />
        </View>
    );
};

const st = StyleSheet.create({
    // Always LTR: under RTL React Native swaps absolute left/right but not translateX, which would throw every object off the stage.
    stage: { width: STAGE.width, height: STAGE.height, backgroundColor: C.ground, overflow: 'hidden', direction: 'ltr' },
    cap: { color: C.ink, fontSize: 82, lineHeight: 92, fontWeight: '700', letterSpacing: -1 },
    capLong: { fontSize: 62, lineHeight: 72 },
    capRtl: { textAlign: 'right', writingDirection: 'rtl' },
    sub: { color: C.sub, fontSize: 40, lineHeight: 56, marginTop: 24 },
    centred: { alignItems: 'center', justifyContent: 'center' },
    flex: { flex: 1 },
    gap10: { gap: 10 },
    mt16: { marginTop: 16 },
    clip: { overflow: 'hidden' },
    socialBar: { height: 100, paddingHorizontal: 30, gap: 28 },
    socialMark: { width: 170, height: 34, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.85)' },
    post: { paddingBottom: 28, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
    postHead: { height: 90, paddingHorizontal: 24, gap: 16 },
    postAv: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)' },
    postHandle: { width: 180, height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.4)' },
    postImage: { height: 440, alignItems: 'center', justifyContent: 'center' },
    postBadge: { position: 'absolute', top: 24, right: 24, width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
    badgeFake: { backgroundColor: '#EF4444' },
    badgeRage: { backgroundColor: '#F97316' },
    postActions: { height: 90, paddingHorizontal: 24, gap: 26 },
    postReact: { color: C.ink2, fontSize: 30, fontWeight: '700' },
    postBar: { height: 16, borderRadius: 8, marginHorizontal: 24, marginTop: 6, backgroundColor: 'rgba(255,255,255,0.22)' },
    postBarShort: { width: '55%', marginTop: 12, opacity: 0.6 },
    bubble: { fontSize: 72 },
    phone2: { paddingVertical: 44, paddingHorizontal: 20 },
    avatar: { alignSelf: 'center', width: 110, height: 110, borderRadius: 55, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 3, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
    skel: { marginTop: 16, padding: 18, borderRadius: 24, backgroundColor: C.card },
    skelBar: { height: 15, borderRadius: 8, backgroundColor: C.bar, marginBottom: 12 },
    skelShort: { width: '60%', opacity: 0.6 },
    chipRing: { ...StyleSheet.absoluteFillObject, margin: -10, borderRadius: 54, borderWidth: 6, borderColor: C.accent },
    chipTap: { position: 'absolute', right: 24, top: -6, width: 96, height: 96, borderRadius: 48, borderWidth: 5, borderColor: C.ink, backgroundColor: 'rgba(255,255,255,0.3)' },
    webDot: { position: 'absolute', left: BOX_W / 2, top: BOX_H / 2 },
    hub: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#26262a', borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center' },
    wall: { position: 'absolute', left: 0, top: WALL_Y },
    globe: { position: 'absolute', left: HUB[0] - GLOBE_R, top: HUB[1] - GLOBE_R },
    cell: { width: 15, height: 11, borderRadius: 2.5, backgroundColor: C.accent },
    cellDim: { opacity: 0.6 },
    shot: { width: '100%', height: '100%' },
    hollow: { backgroundColor: 'transparent' },
    badges: { flexDirection: 'row', justifyContent: 'space-between' },
    appStore: { width: BADGE_H * (119.66 / 40), height: BADGE_H },
    googlePlay: { width: BADGE_H * (180 / 53.33), height: BADGE_H },
    trayBlock: { width: 32, height: 13, borderRadius: 4, backgroundColor: C.accent },
    readScan: { backgroundColor: C.accent, borderRadius: 2 },
    rowC: { flexDirection: 'row', alignItems: 'center' },
    gridCard: { flex: 1, padding: 18, borderRadius: 22, backgroundColor: C.card, borderWidth: 2, borderColor: 'rgba(255,255,255,0.1)' },
    gridAv: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#303034', alignItems: 'center', justifyContent: 'center' },
    gridAvText: { color: C.ink, fontSize: 16, fontWeight: '700' },
    gridSrc: { width: 110, height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.2)' },
    gridRel: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, backgroundColor: '#FCE3CF' },
    gridRelMed: { backgroundColor: '#E6EEF8' },
    gridRelText: { color: '#5a2d10', fontSize: 16, fontWeight: '700' },
    gridRelTextMed: { color: '#22344d' },
    gridBar: { height: 13, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.3)' },
    gridBarShort: { width: '70%', opacity: 0.6, marginTop: 10 },
    gridNote: { marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.35)' },
    gridNoteBar: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.35)' },
    gridNoteShort: { width: '75%', opacity: 0.6, marginTop: 8 },
    // The beam pivots on the mark's bottom dot (viewBox 512,760 drawn at 280x400).
    beam: { transformOrigin: '140px 334px' },
    lockBody: { borderRadius: 56, borderWidth: 12, borderColor: C.ink, backgroundColor: 'rgba(255,255,255,0.06)' },
    pulse: { borderRadius: 300, borderWidth: 4, borderColor: C.ink },
});
