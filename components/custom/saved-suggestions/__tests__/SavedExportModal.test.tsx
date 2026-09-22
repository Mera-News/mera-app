/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for the three-step saved-articles export wizard.
//
// Two things this file is careful about, because both have produced green
// assertions that checked nothing elsewhere in this repo:
//
//   1. The FlatList mock below names `ListHeaderComponent` and
//      `ListFooterComponent` even though the component under test passes
//      NEITHER. A hand-rolled mock silently drops the props it did not
//      destructure, so the day someone moves the select-all row into that slot
//      the absence assertions here would keep passing while the control never
//      rendered. Teaching the mock the prop now is what stops that.
//   2. Every absence assertion ships beside the presence assertion that proves
//      the query can find the thing at all.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// react-native, rebuilt to the surface this component uses. The real FlatList
// pulls in VirtualizedList and ScrollView, which do not construct under this
// jest environment.
//
// EVERY list slot is named here, including the two the component does not pass.
// A hand-rolled mock silently drops the props it did not destructure, and this
// repo has already shipped three gating assertions that were green because the
// header they were checking for could never have rendered through a mock that
// ignored the slot. Naming them costs four lines and removes that whole class
// of false green.
jest.mock('react-native', () => {
    const ReactLib = require('react');
    const host = (name: string) => (props: any) =>
        ReactLib.createElement(name, props, props.children);
    const View = host('View');
    const slot = (C: any) =>
        ReactLib.isValidElement(C)
            ? C
            : typeof C === 'function'
              ? ReactLib.createElement(C)
              : null;
    return {
        __esModule: true,
        View,
        Text: host('Text'),
        Pressable: host('View'),
        useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
        StyleSheet: { create: (o: any) => o, flatten: (o: any) => o },
        FlatList: ({
            data,
            renderItem,
            keyExtractor,
            ListHeaderComponent,
            ListFooterComponent,
            ListEmptyComponent,
            ...rest
        }: any) =>
            ReactLib.createElement(
                View,
                rest,
                slot(ListHeaderComponent),
                (data ?? []).length === 0 ? slot(ListEmptyComponent) : null,
                (data ?? []).map((item: any, index: number) =>
                    ReactLib.createElement(
                        ReactLib.Fragment,
                        { key: keyExtractor ? keyExtractor(item, index) : index },
                        renderItem({ item, index }),
                    ),
                ),
                slot(ListFooterComponent),
            ),
    };
});

jest.mock('@expo/vector-icons', () => {
    const ReactLib = require('react');
    return { MaterialIcons: (p: any) => ReactLib.createElement('MaterialIcons', p) };
});

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: any) => (o?.count !== undefined ? `${k}:${o.count}` : k),
    }),
}));

// --- gluestack ui → RN primitives -----------------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const Passthrough = (p: any) => <View {...p} />;
    const Modal = ({ isOpen, children, ...rest }: any) =>
        isOpen ? <View {...rest}>{children}</View> : null;
    return {
        Modal,
        ModalBackdrop: Passthrough,
        ModalContent: Passthrough,
        ModalHeader: Passthrough,
        ModalBody: Passthrough,
        ModalFooter: Passthrough,
    };
});

// TranslatableDynamic reaches the on-device translator and a Zustand store.
// The headline it is HANDED is what matters here, so the stub renders it.
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn() },
}));

const mockExportAndShare = jest.fn();
jest.mock('../export-and-share', () => ({
    exportAndShare: (...args: unknown[]) => mockExportAndShare(...args),
}));

import SavedExportModal from '../SavedExportModal';

// --- fixtures ---------------------------------------------------------------
// Two suggestion rows and one standalone save, so the reason branch has both
// kinds in it and no assertion can pass by every row being identical.
const suggestion = (id: string, title: string, reason: string) => ({
    origin: 'suggestion' as const,
    savedAt: Date.UTC(2026, 8, 21),
    suggestion: {
        _id: id,
        articleId: `art-${id}`,
        clusters: [],
        relevance: 0.6,
        reason,
        status: 'complete',
        country_code: 'NLD',
        language_code: 'nl',
        publication_name: 'The Guardian',
        title_en: title,
        title_original: `${title} (nl)`,
        description_en: null,
        article_url: `https://example.com/${id}`,
        image_url: null,
        userTopicIds: [],
        createdAt: '2026-09-19T06:00:00.000Z',
        firstPubDate: '2026-09-20T06:00:00.000Z',
        rawScore: null,
        eventType: null,
    },
}) as never;

const standalone = {
    origin: 'article' as const,
    savedId: 'sv-3',
    savedAt: Date.UTC(2026, 8, 20),
    article: {
        _id: 'art-3',
        article_url: 'https://example.org/three',
        source_uri: 'https://example.org/three',
        title: 'Derde artikel',
        title_en: 'Third article',
        description: '',
        pubDate: '2026-09-18T12:00:00.000Z',
    },
} as never;

const ITEMS = [
    suggestion('sv-1', 'First headline', 'Because it is near you.'),
    suggestion('sv-2', 'Second headline', 'Because you follow this.'),
    standalone,
];

function renderModal(over: Partial<React.ComponentProps<typeof SavedExportModal>> = {}) {
    const onClose = jest.fn();
    const onFailed = jest.fn();
    const utils = render(
        <SavedExportModal
            isOpen
            onClose={onClose}
            items={ITEMS}
            onFailed={onFailed}
            {...over}
        />,
    );
    return { ...utils, onClose, onFailed };
}

beforeEach(() => {
    mockExportAndShare.mockReset();
    mockExportAndShare.mockResolvedValue({ status: 'shared', via: 'file' });
});

describe('step 1 — choosing articles', () => {
    it('renders a row per saved item, showing the headline the card shows', () => {
        const { getByTestId, getByText } = renderModal();

        expect(getByTestId('saved-export-row-sv-1')).toBeTruthy();
        expect(getByTestId('saved-export-row-sv-2')).toBeTruthy();
        expect(getByTestId('saved-export-row-sv-3')).toBeTruthy();
        expect(getByText('First headline')).toBeTruthy();
        expect(getByText('Third article')).toBeTruthy();
    });

    it('starts with NOTHING selected, so select-all is an action and not a no-op', () => {
        const { getByTestId } = renderModal();

        expect(getByTestId('saved-export-select-all').props.accessibilityState.checked).toBe(false);
        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(false);
        expect(getByTestId('saved-export-count').props.children).toBe(
            'savedExport.selectedCount:0',
        );
    });

    it('select-all checks every row, and tapping it again clears them', () => {
        const { getByTestId } = renderModal();

        fireEvent.press(getByTestId('saved-export-select-all'));
        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(true);
        expect(getByTestId('saved-export-row-sv-3').props.accessibilityState.checked).toBe(true);
        expect(getByTestId('saved-export-count').props.children).toBe(
            'savedExport.selectedCount:3',
        );

        fireEvent.press(getByTestId('saved-export-select-all'));
        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(false);
        expect(getByTestId('saved-export-count').props.children).toBe(
            'savedExport.selectedCount:0',
        );
    });

    it('unchecking one row unchecks select-all but leaves the others alone', () => {
        const { getByTestId } = renderModal();

        fireEvent.press(getByTestId('saved-export-select-all'));
        fireEvent.press(getByTestId('saved-export-row-sv-2'));

        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(true);
        expect(getByTestId('saved-export-row-sv-2').props.accessibilityState.checked).toBe(false);
        expect(getByTestId('saved-export-select-all').props.accessibilityState.checked).toBe(false);
    });

    it('Next is disabled at zero selected and enabled once something is', () => {
        const { getByTestId } = renderModal();

        expect(getByTestId('saved-export-next').props.accessibilityState.disabled).toBe(true);
        fireEvent.press(getByTestId('saved-export-next'));
        // Still on step 1: the row list is the discriminator.
        expect(getByTestId('saved-export-row-sv-1')).toBeTruthy();

        fireEvent.press(getByTestId('saved-export-row-sv-1'));
        expect(getByTestId('saved-export-next').props.accessibilityState.disabled).toBe(false);
    });

    it('has no Back control on the first step', () => {
        const { queryByTestId, getByTestId } = renderModal();
        // Presence assertion beside the absence one: the query CAN find a
        // header control, so the null below is about Back and not about the
        // query failing to reach the header at all.
        expect(getByTestId('saved-export-next')).toBeTruthy();
        expect(queryByTestId('saved-export-back')).toBeNull();
    });
});

describe('step 2 — the reason toggle', () => {
    function advanceToStep2() {
        const utils = renderModal();
        fireEvent.press(utils.getByTestId('saved-export-select-all'));
        fireEvent.press(utils.getByTestId('saved-export-next'));
        return utils;
    }

    it('is reached by Next and defaults to including the reason', () => {
        const { getByTestId, queryByTestId } = advanceToStep2();

        expect(getByTestId('saved-export-include-reason')).toBeTruthy();
        expect(
            getByTestId('saved-export-include-reason').props.accessibilityState.checked,
        ).toBe(true);
        expect(queryByTestId('saved-export-row-sv-1')).toBeNull();
    });

    it('toggles off, and Back returns to step 1 with the selection intact', () => {
        const { getByTestId } = advanceToStep2();

        fireEvent.press(getByTestId('saved-export-include-reason'));
        expect(
            getByTestId('saved-export-include-reason').props.accessibilityState.checked,
        ).toBe(false);

        fireEvent.press(getByTestId('saved-export-back'));
        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(true);
        expect(getByTestId('saved-export-count').props.children).toBe(
            'savedExport.selectedCount:3',
        );
    });
});

describe('step 3 — format and hand-off', () => {
    function advanceToStep3(opts: { reason?: boolean } = {}) {
        const utils = renderModal();
        fireEvent.press(utils.getByTestId('saved-export-select-all'));
        fireEvent.press(utils.getByTestId('saved-export-next'));
        if (opts.reason === false) {
            fireEvent.press(utils.getByTestId('saved-export-include-reason'));
        }
        fireEvent.press(utils.getByTestId('saved-export-next'));
        return utils;
    }

    it('offers both formats and drops the Next control', () => {
        const { getByTestId, queryByTestId } = advanceToStep3();

        expect(getByTestId('saved-export-format-markdown')).toBeTruthy();
        expect(getByTestId('saved-export-format-json')).toBeTruthy();
        // The format buttons ARE the commit, so there is nothing left to
        // advance to. Back still exists, which is what proves the header
        // rendered and this null is about Next.
        expect(getByTestId('saved-export-back')).toBeTruthy();
        expect(queryByTestId('saved-export-next')).toBeNull();
    });

    it('shares Markdown carrying the reasons, then closes', async () => {
        const { getByTestId, onClose, onFailed } = advanceToStep3();

        fireEvent.press(getByTestId('saved-export-format-markdown'));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        const [call] = mockExportAndShare.mock.calls;
        expect(call[0].format).toBe('markdown');
        expect(call[0].content).toContain('## First headline');
        expect(call[0].content).toContain('Because it is near you.');
        expect(onFailed).not.toHaveBeenCalled();
    });

    it('shares JSON, and step 2 governs the reason in it too', async () => {
        const { getByTestId, onClose } = advanceToStep3({ reason: false });

        fireEvent.press(getByTestId('saved-export-format-json'));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        const payload = JSON.parse(mockExportAndShare.mock.calls[0][0].content);
        expect(payload.count).toBe(3);
        expect(payload.includesReason).toBe(false);
        expect(payload.articles.every((a: { reason: null }) => a.reason === null)).toBe(true);
    });

    it('exports only the selected rows, not the whole list', async () => {
        const utils = renderModal();
        fireEvent.press(utils.getByTestId('saved-export-row-sv-2'));
        fireEvent.press(utils.getByTestId('saved-export-next'));
        fireEvent.press(utils.getByTestId('saved-export-next'));
        fireEvent.press(utils.getByTestId('saved-export-format-json'));

        await waitFor(() => expect(mockExportAndShare).toHaveBeenCalled());
        const payload = JSON.parse(mockExportAndShare.mock.calls[0][0].content);
        expect(payload.count).toBe(1);
        expect(payload.articles[0].title).toBe('Second headline');
    });

    it('raises the failure callback when the hand-off failed', async () => {
        mockExportAndShare.mockResolvedValue({ status: 'failed', error: new Error('nope') });
        const { getByTestId, onFailed, onClose } = advanceToStep3();

        fireEvent.press(getByTestId('saved-export-format-json'));

        await waitFor(() => expect(onFailed).toHaveBeenCalled());
        // Still closes: the toast is the report, and leaving the wizard open
        // over it would hide the thing explaining what happened.
        expect(onClose).toHaveBeenCalled();
    });

    it('does not raise the failure callback for the degraded text share', async () => {
        mockExportAndShare.mockResolvedValue({ status: 'shared', via: 'text' });
        const { getByTestId, onFailed, onClose } = advanceToStep3();

        fireEvent.press(getByTestId('saved-export-format-json'));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        // The reader got their export. A fallback is not a failure.
        expect(onFailed).not.toHaveBeenCalled();
    });
});

describe('reopening', () => {
    it('resets to step 1 with nothing selected', () => {
        const onClose = jest.fn();
        const onFailed = jest.fn();
        const props = { items: ITEMS, onClose, onFailed };
        const { getByTestId, rerender, queryByTestId } = render(
            <SavedExportModal isOpen {...props} />,
        );

        fireEvent.press(getByTestId('saved-export-select-all'));
        fireEvent.press(getByTestId('saved-export-next'));
        expect(getByTestId('saved-export-include-reason')).toBeTruthy();

        rerender(<SavedExportModal isOpen={false} {...props} />);
        expect(queryByTestId('saved-export-modal')).toBeNull();

        rerender(<SavedExportModal isOpen {...props} />);
        expect(getByTestId('saved-export-row-sv-1').props.accessibilityState.checked).toBe(false);
        expect(getByTestId('saved-export-count').props.children).toBe(
            'savedExport.selectedCount:0',
        );
    });
});
