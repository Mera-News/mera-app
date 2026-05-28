/* eslint-disable @typescript-eslint/no-require-imports */
import { render } from '@testing-library/react-native';
import React from 'react';

// Stub the css-interop JSX wrapper layer. Its safe-area-context shim reads
// Platform.OS at module load, which is undefined under jest-expo's setup.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return {
        jsx: ReactJSXRuntime.jsx,
        jsxs: ReactJSXRuntime.jsxs,
        Fragment: ReactJSXRuntime.Fragment,
    };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return {
        jsxDEV: ReactJSXRuntime.jsxDEV,
        Fragment: ReactJSXRuntime.Fragment,
    };
});

jest.mock('@/components/ui/progress', () => {
    const { View } = require('react-native');
    const Progress = ({ children, ...rest }: any) => <View {...rest}>{children}</View>;
    const ProgressFilledTrack = (props: any) => <View {...props} />;
    return { Progress, ProgressFilledTrack };
});

jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});

jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});

jest.mock('@/components/ui/tooltip', () => {
    const React = require('react');
    const { View } = require('react-native');
    const Tooltip = ({ trigger, children }: any) => (
        <View>
            {trigger({})}
            {children}
        </View>
    );
    const TooltipContent = ({ children }: any) => <View>{children}</View>;
    const TooltipText = ({ children }: any) => <>{children}</>;
    return { Tooltip, TooltipContent, TooltipText };
});

// eslint-disable-next-line import/first
import MultiStepProgressBar from '@/components/custom/MultiStepProgressBar';

const getValue = (queryByTestId: (id: string) => any, i: number): number =>
    queryByTestId(`multi-step-progress-segment-${i}`).props.value;

describe('MultiStepProgressBar', () => {
    it('fills past stages to 100, current to stageValue, future to 0', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar totalStages={4} currentStage={2} stageValue={40} />,
        );
        expect(getValue(getByTestId, 0)).toBe(100);
        expect(getValue(getByTestId, 1)).toBe(100);
        expect(getValue(getByTestId, 2)).toBe(40);
        expect(getValue(getByTestId, 3)).toBe(0);
    });

    it('clamps stageValue above 100 down to 100', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar totalStages={3} currentStage={1} stageValue={150} />,
        );
        expect(getValue(getByTestId, 1)).toBe(100);
    });

    it('clamps negative stageValue up to 0', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar totalStages={3} currentStage={1} stageValue={-20} />,
        );
        expect(getValue(getByTestId, 1)).toBe(0);
    });

    it('fills every segment when currentStage >= totalStages (done flash)', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar totalStages={4} currentStage={4} stageValue={0} />,
        );
        for (let i = 0; i < 4; i++) {
            expect(getValue(getByTestId, i)).toBe(100);
        }
    });

    it('empties every segment when currentStage < 0', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar totalStages={3} currentStage={-1} stageValue={50} />,
        );
        for (let i = 0; i < 3; i++) {
            expect(getValue(getByTestId, i)).toBe(0);
        }
    });

    it('renders one label per segment when stageNames is provided', () => {
        const { getByTestId, getByText } = render(
            <MultiStepProgressBar
                totalStages={4}
                currentStage={1}
                stageValue={20}
                stageNames={['A', 'B', 'C', 'D']}
            />,
        );
        const labels = getByTestId('multi-step-progress-labels');
        expect(labels).toBeTruthy();
        expect(getByText('A')).toBeTruthy();
        expect(getByText('B')).toBeTruthy();
        expect(getByText('C')).toBeTruthy();
        expect(getByText('D')).toBeTruthy();
    });

    it('does not render a labels row when stageNames is omitted', () => {
        const { queryByTestId } = render(
            <MultiStepProgressBar totalStages={3} currentStage={0} stageValue={10} />,
        );
        expect(queryByTestId('multi-step-progress-labels')).toBeNull();
    });

    it('warns in __DEV__ when stageNames length mismatches totalStages', () => {
        const warnSpy = console.warn as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
        warnSpy.mockClear();
        render(
            <MultiStepProgressBar
                totalStages={3}
                currentStage={0}
                stageValue={0}
                stageNames={['only-one']}
            />,
        );
        expect(warnSpy).toHaveBeenCalled();
        const message = warnSpy.mock.calls.map((c) => (c as unknown[]).join(' ')).join('\n');
        expect(message).toMatch(/stageNames/);
    });

    it('wraps segments with tooltip text in a Pressable trigger, others bare', () => {
        const { getByTestId, queryByTestId } = render(
            <MultiStepProgressBar
                totalStages={3}
                currentStage={0}
                stageValue={0}
                stageTooltips={['t0', undefined, 't2']}
            />,
        );
        expect(getByTestId('multi-step-progress-tooltip-trigger-0')).toBeTruthy();
        expect(queryByTestId('multi-step-progress-tooltip-trigger-1')).toBeNull();
        expect(getByTestId('multi-step-progress-tooltip-trigger-2')).toBeTruthy();
    });

    it('forwards progressClassName and progressFilledClassName to track/fill', () => {
        const { getByTestId } = render(
            <MultiStepProgressBar
                totalStages={2}
                currentStage={0}
                stageValue={0}
                progressClassName="custom-track-class"
                progressFilledClassName="custom-fill-class"
            />,
        );
        const seg = getByTestId('multi-step-progress-segment-0');
        const fill = getByTestId('multi-step-progress-fill-0');
        expect(String(seg.props.className ?? '')).toMatch(/custom-track-class/);
        expect(String(fill.props.className ?? '')).toMatch(/custom-fill-class/);
    });
});
