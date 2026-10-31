// Browser entry for the video export: the app's own film, on react-native-web,
// with its clock driven by reel.mjs through window.renderFrame(t).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Animated, View } from 'react-native';

import { feedShotFor } from '../film/shots';
import { STAGE } from '../film/stage';
import { WelcomeFilm, type WelcomePromo } from '../film/welcome';
import { resolveWelcomeCopy } from '../film/welcome-script';

type Dict = Record<string, unknown>;

interface FilmInput {
    readonly dict: Dict;
    readonly fallback: Dict;
    readonly rtl: boolean;
    readonly scale: number;
    readonly t0: number;
    /** The app's language code for the For You screenshot (zh-Hans, not zh-CN). */
    readonly appCode: string;
    /** The promo end card's line; set only for the promo cut (English). */
    readonly promoLine?: string;
}

declare global {
    interface Window {
        FILM_INPUT: FilmInput;
        renderFrame?: (t: number) => void;
    }
}

const lookupIn = (dict: Dict, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Dict | undefined)?.[part], dict);

const input = window.FILM_INPUT;
const copy = resolveWelcomeCopy((key) => {
    const v = lookupIn(input.dict, key) ?? lookupIn(input.fallback, key);
    if (typeof v !== 'string') throw new Error(`missing copy: ${key}`);
    return v;
});

// esbuild's file loader turns each into a URL next to the bundle; the app never bundles them.
const promo: WelcomePromo | undefined = input.promoLine
    ? { chatShot: require('./promo/chat-en.jpg') as string, appStore: require('./promo/app-store.svg') as string, googlePlay: require('./promo/google-play.svg') as string, line: input.promoLine }
    : undefined;

const clock = new Animated.Value(input.t0);
window.renderFrame = (t) => clock.setValue(t);

const { width, height } = STAGE;
const k = input.scale;
createRoot(document.getElementById('root') as HTMLElement).render(
    <View style={{ width: width * k, height: height * k, overflow: 'hidden' }}>
        <View style={{ width, height, transform: [{ translateX: (width * (k - 1)) / 2 }, { translateY: (height * (k - 1)) / 2 }, { scale: k }] }}>
            <WelcomeFilm t={clock} copy={copy} rtl={input.rtl} feedShot={feedShotFor(input.appCode)} promo={promo} />
        </View>
    </View>,
);
