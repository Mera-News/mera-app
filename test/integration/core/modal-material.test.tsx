// ModalMaterial on Android paints its glows as CSS gradient layers, not an Svg bitmap raster.
import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ModalMaterial from '@/components/custom/ModalMaterial';

const original = Platform.OS;
afterEach(() => {
    Platform.OS = original;
});

const paint = async (os: 'ios' | 'android', scheme: 'dark' | 'light') => {
    Platform.OS = os;
    await render(<ModalMaterial scheme={scheme} />);
    const root = screen.toJSON() as any;
    return { root, style: StyleSheet.flatten(root.props.style) };
};

/** Any host node whose type names an RNSVG view. */
const hasSvg = (n: any): boolean =>
    !!n && typeof n === 'object' && (/RNSVG/.test(n.type ?? '') || (n.children ?? []).some(hasSvg));

describe('ModalMaterial', () => {
    it('android draws no Svg and puts the gradient layers on the view', async () => {
        const { style } = await paint('android', 'dark');
        await fireEvent(screen.root!, 'layout', { nativeEvent: { layout: { width: 300, height: 400 } } });
        expect(hasSvg(screen.toJSON())).toBe(false);
        expect(style.experimental_backgroundImage).toBe(
            [
                'linear-gradient(rgba(255,255,255,0.02), rgba(255,255,255,0.02))',
                'radial-gradient(ellipse 260px 200px at 40% 112%, rgba(13,166,242,0.12) 0%, rgba(13,166,242,0) 100%)',
                'radial-gradient(ellipse 240px 240px at 96% 72%, rgba(150,120,220,0.14) 0%, rgba(150,120,220,0) 100%)',
                'radial-gradient(ellipse 220px 240px at 10% 8%, rgba(231,138,83,0.2) 0%, rgba(231,138,83,0) 100%)',
            ].join(', '),
        );
    });

    it('android light theme carries the stronger alphas over the dark wash', async () => {
        const { style } = await paint('android', 'light');
        expect(style.experimental_backgroundImage).toBe(
            [
                'linear-gradient(rgba(18,17,19,0.07), rgba(18,17,19,0.07))',
                'radial-gradient(ellipse 260px 200px at 40% 112%, rgba(13,166,242,0.22) 0%, rgba(13,166,242,0) 100%)',
                'radial-gradient(ellipse 240px 240px at 96% 72%, rgba(150,120,220,0.26) 0%, rgba(150,120,220,0) 100%)',
                'radial-gradient(ellipse 220px 240px at 10% 8%, rgba(231,138,83,0.34) 0%, rgba(231,138,83,0) 100%)',
            ].join(', '),
        );
    });

    it('ios still draws the Svg once measured', async () => {
        const { root } = await paint('ios', 'dark');
        expect(hasSvg(root)).toBe(false);
        await fireEvent(screen.root!, 'layout', { nativeEvent: { layout: { width: 300, height: 400 } } });
        expect(hasSvg(screen.toJSON())).toBe(true);
    });
});
