/* eslint-disable @typescript-eslint/no-require-imports */
// The shared ••• menu (D3): which items appear where, that items run AFTER the
// sheet closes, that a failure offers a retry, and that Report a bug carries no
// article context.
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

let mockModal: any = null;
let mockModalImpl: any = null;
let mockModalMounted = false;
let mockModalMounts = 0;
let mockOS = 'ios';
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Modal') {
                // Records its props so a test can play the native dismissal
                // (`onDismiss`, iOS only) at the moment it chooses. ONE component
                // identity (cached), so a re-render never counts as a remount.
                if (mockModalImpl) return mockModalImpl;
                mockModalImpl = (props: any) => {
                    mockModal = props;
                    // Tracks whether the Modal HOST is still in the tree, so a
                    // test can prove an item ran only after it was removed.
                    ReactLib.useEffect(() => {
                        mockModalMounted = true;
                        mockModalMounts += 1;
                        return () => {
                            mockModalMounted = false;
                        };
                    }, []);
                    return props.visible === false
                        ? null
                        : ReactLib.createElement(ReactLib.Fragment, null, props.children);
                };
                return mockModalImpl;
            }
            if (prop === 'Platform') return { ...actual.Platform, OS: mockOS };
            return (target as any)[prop];
        },
    });
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
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
        t: (k: string, o?: Record<string, string>) => (o?.source ? `${k}:${o.source}` : k),
        i18n: { language: 'en' },
    }),
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({
    GLASS_OVER_CONTENT_FILL: '#111',
    TranslucentPlate: () => null,
}));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
const mockToastShow = jest.fn();
jest.mock('@/components/ui/toast', () => ({
    Toast: ({ children }: any) => children,
    ToastTitle: ({ children }: any) => children,
    useToast: () => ({ show: mockToastShow, close: jest.fn() }),
}));
const mockFollow = {
    tracked: false,
    outcome: 'start' as 'tracked' | 'locked' | 'start',
    startTracking: jest.fn(),
    goToStory: jest.fn(),
    seePlans: jest.fn(async () => {}),
};
jest.mock('@/components/custom/tracked-stories/use-track-button', () => ({
    useTrackButton: () => ({
        tracked: mockFollow.tracked,
        resolve: () => mockFollow.outcome,
        startTracking: mockFollow.startTracking,
        goToStory: mockFollow.goToStory,
        seePlans: mockFollow.seePlans,
    }),
}));
const mockAsk = jest.fn((..._a: any[]) => true);
jest.mock('@/components/custom/floating-chat/ask-mera', () => ({
    askMeraAbout: (...a: any[]) => mockAsk(...a),
}));
const mockSetPref = jest.fn(async (..._a: any[]) => ({ applied: true }));
jest.mock('@/lib/database/services/publication-pref-ui-actions', () => ({
    setSourcePrefFromUi: (...a: any[]) => mockSetPref(...a),
}));
const mockShowFeedback = jest.fn();
jest.mock('@/lib/feedback', () => ({ showFeedback: (...a: any[]) => mockShowFeedback(...a) }));
let mockSentry = true;
jest.mock('@/lib/sentry-init', () => ({
    get SENTRY_ENABLED() {
        return mockSentry;
    },
}));
const mockOpenOnSource = jest.fn(async (..._a: any[]) => true);
jest.mock('@/components/custom/cards/article-actions', () => ({
    openOnSource: (...a: any[]) => mockOpenOnSource(...a),
    openInGoogleTranslate: jest.fn(async () => true),
    isForeignLanguage: (lang: string | null, app: string | null) =>
        !lang || !app || lang.split('-')[0] !== app.split('-')[0],
}));

// The tree level is its own suite (feedback-tree-sheet.test.tsx). Here it is a
// stub that shows which root and depth the sheet asked for.
jest.mock('@/components/custom/feedback-tree/FeedbackTreeLevel', () => {
    const { Pressable, Text } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => (
            <>
                <Text testID={`tree-${p.root}-${p.pathIds.join('.') || 'root'}`}>tree</Text>
                <Pressable testID="tree-descend" onPress={() => p.onDescend({ id: 'n1', children: [{ id: 'c' }] })} />
                <Pressable
                    testID="tree-leaf"
                    onPress={() => p.onLeaf({ id: 'seen', labelKey: 'k', leaf: { seenOnly: true } }, [...p.pathIds, 'seen'])}
                />
                <Pressable
                    testID="tree-chat"
                    onPress={() => p.onLeaf({ id: 'why', labelKey: 'k', leaf: { openChat: true } }, [...p.pathIds, 'why'])}
                />
                <Pressable
                    testID="tree-browse"
                    onPress={() =>
                        p.onLeaf({ id: 'rel', labelKey: 'k', leaf: { nudge: 'browse_related' } }, [...p.pathIds, 'rel'])
                    }
                />
                <Pressable
                    testID="tree-apply"
                    onPress={() =>
                        p.onLeaf(
                            {
                                id: 'less_entity',
                                labelKey: 'k',
                                labelDefault: 'Show less of {{entity}}',
                                leaf: { actions: [{ type: 'add_suppression', pattern: 'from_context_entity', kind: 'entity', strength: 0.5 }] },
                            },
                            [...p.pathIds, 'less_entity'],
                        )
                    }
                />
                <Text testID="tree-context">{JSON.stringify(p.context)}</Text>
            </>
        ),
    };
});
let mockTreePromise: Promise<any> = Promise.resolve({ version: 1, root: [], likeRoot: [] });
const mockRefreshTree = jest.fn(async () => {});
jest.mock('@/lib/services/feedback-tree-service', () => ({
    getFeedbackTree: jest.fn(() => mockTreePromise),
    refreshFeedbackTree: (...a: any[]) => mockRefreshTree(...(a as [])),
}));
const mockApplyLeaf = jest.fn(async (..._a: any[]) => 1);
jest.mock('@/components/custom/feedback-tree/apply-leaf-actions', () => ({
    applyLeafActions: (...a: any[]) => mockApplyLeaf(...a),
}));
jest.mock('@/components/custom/feedback-tree/label-vars', () => ({
    feedbackNodeLabel: (_t: any, node: any, ctx: any) => `label:${node.id}:${ctx.entity ?? ''}`,
}));
const mockOpenArticleFeedback = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: { getState: () => ({ openArticleFeedback: mockOpenArticleFeedback }) },
}));
jest.mock('@/lib/stores/subscription-store', () => ({ getAiAccess: () => 'full' }));
jest.mock('@/components/custom/cards/overlay-context', () => ({
    buildOverlayContext: jest.fn(async (s: any) => ({ articleTitle: s.title })),
}));

import { MENU_DISMISS_FALLBACK_MS, useArticleMenu, type UseArticleMenuInput } from '../use-article-menu';

const subject = {
    origin: 'suggestion' as const,
    surface: 'for_you',
    articleId: 'art-1',
    suggestionId: 'sug-1',
    title: 'A headline',
    publicationName: 'NOS',
};

function Host(props: Partial<UseArticleMenuInput>) {
    const menu = useArticleMenu({
        surface: 'card',
        subject,
        articleUrl: 'https://nos.nl/a',
        languageCode: 'nl',
        ...props,
    });
    const { Pressable, Text } = require('react-native');
    return (
        <>
            <Pressable testID="open" onPress={menu.open}>
                <Text>open</Text>
            </Pressable>
            <Pressable testID="open-like-tree" onPress={() => menu.openFeedback('like')}>
                <Text>like</Text>
            </Pressable>
            {menu.element}
        </>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSentry = true;
    mockModal = null;
    mockOS = 'ios';
    mockFollow.tracked = false;
    mockFollow.outcome = 'start';
    mockModalMounts = 0;
    mockTreePromise = Promise.resolve({ version: 1, root: [], likeRoot: [] });
});
afterEach(() => jest.useRealTimers());

const openMenu = (ui: React.ReactElement) => {
    const r = render(ui);
    fireEvent.press(r.getByTestId('open'));
    return r;
};

describe('useArticleMenu items', () => {
    it('offers the full set on a card for a foreign-language article', () => {
        const r = openMenu(<Host onCheckFacts={jest.fn()} />);
        for (const id of [
            'card-action-mera',
            'card-action-track',
            'card-action-fact-check',
            'menu-open-source',
            'menu-open-translate',
            'menu-fewer-from-source',
            'menu-report-bug',
            'article-menu-cancel',
        ]) {
            expect(r.getByTestId(id)).toBeTruthy();
        }
        expect(r.getByText('articleMenu.openOn:NOS')).toBeTruthy();
    });

    it('omits Open on source on the detail screen, where it is the main button', () => {
        const r = openMenu(<Host surface="detail" />);
        expect(r.queryByTestId('menu-open-source')).toBeNull();
    });

    it('omits Google Translate for an article already in the reader\'s language', () => {
        const r = openMenu(<Host languageCode="en" />);
        expect(r.queryByTestId('menu-open-translate')).toBeNull();
    });

    it('omits Report a bug when Sentry is off, so the item never does nothing', () => {
        mockSentry = false;
        const r = openMenu(<Host />);
        expect(r.queryByTestId('menu-report-bug')).toBeNull();
    });

    it('omits Check for fact checks when the surface cannot start one', () => {
        const r = openMenu(<Host />);
        expect(r.queryByTestId('card-action-fact-check')).toBeNull();
    });
});

describe('ArticleOverflowMenu sheet', () => {
    it('titles the sheet with the headline, not a generic label', () => {
        const r = openMenu(<Host />);
        expect(r.getByTestId('article-menu-title').props.children).toBe('A headline');
        expect(r.getByTestId('article-menu-title').props.numberOfLines).toBe(1);
    });

    it('clears the home indicator and gives Cancel its own readable plate', () => {
        const r = openMenu(<Host />);
        const { StyleSheet } = require('react-native');
        expect(StyleSheet.flatten(r.getByTestId('article-menu').props.style).paddingBottom).toBe(34 + 12);
        // The plate is a STATIC style on an inner View: a function style on the
        // Pressable itself was dropped on device (740).
        const plate = StyleSheet.flatten(r.getByTestId('article-menu-cancel-plate').props.style);
        expect(plate).toEqual(
            expect.objectContaining({ minHeight: 48, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.10)' }),
        );
    });
});

// The browser bug: an item that presents native UI (SFSafariViewController,
// the feedback form) while the RN Modal is still dismissing is silently
// dropped on iOS, and its await never resolves. Items run AFTER the Modal
// reports it is gone: `onDismiss` on iOS, visible -> false on Android, with a
// fallback and an unmount flush, exactly once. Never on a timer guess.
// The Modal reports its dismissal; the item runs a frame after the sheet
// leaves the tree, so `dismiss` plays both.
/** Let the sheet's slide-down finish: the Modal hides only when it ends.
 *  Twice: the post-exit frame is queued when the first act() flushes. */
const exitSheet = () => {
    act(() => {
        jest.advanceTimersByTime(300);
    });
    act(() => {
        jest.advanceTimersByTime(50);
    });
};
const dismiss = () => {
    exitSheet();
    act(() => {
        mockModal?.onDismiss?.();
    });
    act(() => {
        jest.advanceTimersByTime(20);
    });
};
const flushAsync = async () => {
    await act(async () => {
        await Promise.resolve();
    });
};

describe('compact row actions in the menu', () => {
    const row = (liked: boolean) => ({
        liked,
        saved: false,
        onLike: jest.fn(),
        onDislike: jest.fn(),
        onToggleSave: jest.fn(),
        onShare: jest.fn(),
    });

    it('leads with Like, Not for me, Save and Share only when given row actions', () => {
        const withRow = openMenu(<Host rowActions={row(false)} />);
        for (const id of ['menu-like', 'menu-dislike', 'menu-save', 'menu-share']) {
            expect(withRow.getByTestId(id)).toBeTruthy();
        }
        withRow.unmount();
        const plain = openMenu(<Host />);
        expect(plain.queryByTestId('menu-like')).toBeNull();
    });

    // Batch 10: after a like the item still read "I like it" and a second tap
    // silently removed it. Once liked it says so.
    it('reads "Remove like" once liked, and "Remove from saved" once saved', () => {
        const r = openMenu(<Host rowActions={{ ...row(true), saved: true }} />);
        expect(r.getByTestId('menu-like').props.accessibilityLabel).toBe('articleMenu.removeLike');
        expect(r.getByTestId('menu-save').props.accessibilityLabel).toBe('savedSuggestions.removeAction');
        r.unmount();
        const fresh = openMenu(<Host rowActions={row(false)} />);
        expect(fresh.getByTestId('menu-like').props.accessibilityLabel).toBe('articleFeedback.likeLabel');
    });
});

// Owner: "clicking on 'I like it' should feel like it's opening a submenu ...
// then clicking on back should take user to the main menu". A sub-menu is a
// LEVEL pushed inside the one sheet, never a second Modal.
const settle = () =>
    act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });

describe('the ••• sheet as a navigation stack', () => {
    // Batch 12: pushing first and resolving after drew one row, then grew
    // the sheet. The tree and its context are ready BEFORE the level lands.
    it('pushes the tree only once the tree and its context have resolved', async () => {
        let resolveTree!: (t: any) => void;
        mockTreePromise = new Promise((r) => {
            resolveTree = r;
        });
        const r0 = {
            liked: false, disliked: false, saved: false,
            onLike: jest.fn(), onDislike: jest.fn(), onToggleSave: jest.fn(), onShare: jest.fn(),
        };
        const r = openMenu(<Host rowActions={r0} />);
        fireEvent.press(r.getByTestId('menu-like'));
        expect(r.queryByTestId('tree-like-root')).toBeNull();
        expect(r.getByTestId('menu-save')).toBeTruthy();
        resolveTree({ version: 1, root: [], likeRoot: [] });
        await settle();
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
    });

    const row = (liked: boolean) => ({
        liked,
        saved: false,
        onLike: jest.fn(),
        onDislike: jest.fn(),
        onToggleSave: jest.fn(),
        onShare: jest.fn(),
    });

    it('"I like it" records the like and pushes the like tree into the SAME sheet', async () => {
        const r0 = row(false);
        const r = openMenu(<Host rowActions={r0} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        expect(r0.onLike).toHaveBeenCalledTimes(1);
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
        expect(r.queryByTestId('menu-save')).toBeNull();
        // Same sheet, still open, and no second Modal was ever mounted.
        expect(mockModal.visible).toBe(true);
        expect(mockModalMounts).toBe(1);
        expect(r.getByTestId('sheet-back')).toBeTruthy();
    });

    it('Back from the tree root returns to the main menu rows', async () => {
        const r = openMenu(<Host rowActions={row(false)} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        fireEvent.press(r.getByTestId('sheet-back'));
        expect(r.getByTestId('menu-like')).toBeTruthy();
        expect(r.getByTestId('menu-save')).toBeTruthy();
        expect(r.queryByTestId('sheet-back')).toBeNull();
    });

    it('a deeper level pops back to the tree root, then to the main menu', async () => {
        const r = openMenu(<Host rowActions={row(false)} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        fireEvent.press(r.getByTestId('tree-descend'));
        expect(r.getByTestId('tree-like-n1')).toBeTruthy();
        fireEvent.press(r.getByTestId('sheet-back'));
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
        fireEvent.press(r.getByTestId('sheet-back'));
        expect(r.getByTestId('menu-like')).toBeTruthy();
    });

    it('"Not for me" pushes the dislike tree at its entry level', async () => {
        const r0 = row(false);
        const r = openMenu(<Host rowActions={r0} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-dislike'));
        expect(r0.onDislike).toHaveBeenCalledTimes(1);
        expect(r.getByTestId('tree-dislike-root')).toBeTruthy();
    });

    it('Cancel closes the whole sheet from any depth and runs nothing', async () => {
        const r = openMenu(<Host rowActions={row(false)} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        fireEvent.press(r.getByTestId('tree-descend'));
        fireEvent.press(r.getByTestId('article-menu-cancel'));
        exitSheet();
        expect(mockModal.visible).toBe(false);
        dismiss();
        expect(mockShowFeedback).not.toHaveBeenCalled();
    });

    // The sheet is the only place the tree is shown, so it is also the only
    // place that keeps the cached server tree fresh (throttled in the service).
    it('kicks the throttled server-tree refresh when it prepares the tree', async () => {
        const r = render(<Host />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        expect(mockRefreshTree).toHaveBeenCalledTimes(1);
    });

    it('a tree opened directly (inline thumb, outside •••) has no Back row', async () => {
        const r = render(<Host rowActions={row(false)} />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
        expect(r.queryByTestId('sheet-back')).toBeNull();
        expect(r.getByTestId('article-menu-cancel')).toBeTruthy();
    });

    it('a leaf closes the sheet and reports the path', async () => {
        const picked = jest.fn();
        const r = openMenu(<Host rowActions={row(false)} onLeafPicked={picked} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        fireEvent.press(r.getByTestId('tree-leaf'));
        expect(picked).toHaveBeenCalledWith('like', ['seen'], 0, false);
        exitSheet();
        expect(mockModal.visible).toBe(false);
    });

    // Batch 12 fix 3: "Not for me" mirrors Like. Once disliked it reads
    // "Remove not for me" with the filled glyph, and a tap removes and closes.
    it('reads "Remove not for me" once disliked; a tap removes it and closes, with no tree', async () => {
        const r0 = { ...row(false), disliked: true };
        const r = openMenu(<Host rowActions={r0} />);
        await settle();
        expect(r.getByTestId('menu-dislike').props.accessibilityLabel).toBe('articleMenu.removeDislike');
        fireEvent.press(r.getByTestId('menu-dislike'));
        expect(r0.onDislike).toHaveBeenCalledTimes(1);
        expect(r.queryByTestId('tree-dislike-root')).toBeNull();
        exitSheet();
        expect(mockModal.visible).toBe(false);
    });

    it('"Remove like" removes it and closes, with no tree', async () => {
        const r0 = row(true);
        const r = openMenu(<Host rowActions={r0} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        expect(r0.onLike).toHaveBeenCalledTimes(1);
        expect(r.queryByTestId('tree-like-root')).toBeNull();
        exitSheet();
        expect(mockModal.visible).toBe(false);
    });

    it('Follow on an already-followed story pushes the follow level; Go to story closes then navigates', async () => {
        mockFollow.tracked = true;
        mockFollow.outcome = 'tracked';
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('card-action-track'));
        expect(r.getByTestId('already-tracking-go')).toBeTruthy();
        expect(r.getByTestId('sheet-back')).toBeTruthy();
        fireEvent.press(r.getByTestId('already-tracking-go'));
        exitSheet();
        expect(mockModal.visible).toBe(false);
        dismiss();
        expect(mockFollow.goToStory).toHaveBeenCalledTimes(1);
    });

    it('Follow on a new story closes the sheet, then starts the proposal', async () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('card-action-track'));
        expect(mockFollow.startTracking).not.toHaveBeenCalled();
        dismiss();
        expect(mockFollow.startTracking).toHaveBeenCalledTimes(1);
    });
});

describe('useArticleMenu running items', () => {
    it('iOS: keeps the Modal mounted while it dismisses and runs the item on onDismiss, not on a timer', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        exitSheet();
        expect(mockModal.visible).toBe(false);
        expect(typeof mockModal.onDismiss).toBe('function');
        act(() => {
            jest.advanceTimersByTime(250);
        });
        expect(mockShowFeedback).not.toHaveBeenCalled();
        dismiss();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        // No article id or URL is ever handed to the bug report.
        expect(mockShowFeedback).toHaveBeenCalledWith();
        dismiss();
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    // Batch 10: "I like it" from a compact row wrote the like but its feedback
    // tree (another RN Modal) never appeared. An item may present ANOTHER
    // Modal, which iOS refuses while the menu's Modal host is still mounted,
    // so the item runs only once the sheet is out of the tree, a frame later.
    it('runs the item only after the menu Modal has left the tree', () => {
        let mountedWhenRun: boolean | null = null;
        mockShowFeedback.mockImplementationOnce(() => {
            mountedWhenRun = mockModalMounted;
        });
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        act(() => {
            mockModal?.onDismiss?.();
        });
        expect(mockShowFeedback).not.toHaveBeenCalled();
        act(() => {
            jest.advanceTimersByTime(20);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        expect(mountedWhenRun).toBe(false);
    });

    it('iOS: runs the item once at the fallback when onDismiss never comes', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS - 1);
        });
        expect(mockShowFeedback).not.toHaveBeenCalled();
        act(() => {
            jest.advanceTimersByTime(1);
        });
        act(() => {
            jest.advanceTimersByTime(20);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        dismiss();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('Android: runs the item once the Modal is hidden (no onDismiss there)', () => {
        mockOS = 'android';
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        expect(mockShowFeedback).not.toHaveBeenCalled();
        exitSheet();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('runs a picked item once when the host unmounts mid-dismissal', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-report-bug'));
        r.unmount();
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
        act(() => {
            jest.advanceTimersByTime(MENU_DISMISS_FALLBACK_MS);
        });
        expect(mockShowFeedback).toHaveBeenCalledTimes(1);
    });

    it('Cancel runs nothing and unmounts the sheet after the dismissal', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('article-menu-cancel'));
        dismiss();
        expect(mockShowFeedback).not.toHaveBeenCalled();
        expect(mockOpenOnSource).not.toHaveBeenCalled();
    });

    it('opens on source through the shared helper that records the visit', async () => {
        const visit = { publicationName: 'NOS', countryCode: 'NL', articleId: 'art-1' };
        const r = openMenu(<Host visit={visit} />);
        fireEvent.press(r.getByTestId('menu-open-source'));
        expect(mockOpenOnSource).not.toHaveBeenCalled();
        dismiss();
        await flushAsync();
        expect(mockOpenOnSource).toHaveBeenCalledTimes(1);
        expect(mockOpenOnSource).toHaveBeenCalledWith('https://nos.nl/a', visit);
    });

    it('opens Google Translate the same way, after the dismissal', async () => {
        const { openInGoogleTranslate } = require('@/components/custom/cards/article-actions');
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-open-translate'));
        expect(openInGoogleTranslate).not.toHaveBeenCalled();
        dismiss();
        await flushAsync();
        expect(openInGoogleTranslate).toHaveBeenCalledTimes(1);
        expect(openInGoogleTranslate).toHaveBeenCalledWith('https://nos.nl/a', 'en');
    });

    it('says so, with a retry, when an item fails', async () => {
        mockAsk.mockReturnValueOnce(false);
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('card-action-mera'));
        dismiss();
        await flushAsync();
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });

    it('turns a source down with an undo, never silently', async () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-fewer-from-source'));
        dismiss();
        await flushAsync();
        await flushAsync();
        expect(mockSetPref).toHaveBeenCalledWith({ kind: 'publication', publicationName: 'NOS' }, 'deprioritised');
        expect(mockToastShow).toHaveBeenCalledTimes(1);
    });
});

// The Feed card and the detail screen hand their own hosts the leaves only
// they know how to finish: the chat hand-off carries the verdict and the
// tapped breadcrumb, and "related coverage" opens (or scrolls to) the detail
// footer. Both run after the sheet has gone.
describe('host overrides for the Feed and detail thumbs', () => {
    it('an openChat leaf goes to the host chat hand-off, after the sheet closes', async () => {
        const onFeedbackChat = jest.fn();
        const r = render(<Host onFeedbackChat={onFeedbackChat} />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        fireEvent.press(r.getByTestId('tree-chat'));
        exitSheet();
        expect(mockModal.visible).toBe(false);
        expect(onFeedbackChat).not.toHaveBeenCalled();
        dismiss();
        expect(onFeedbackChat).toHaveBeenCalledWith('like', ['why']);
        expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
    });

    it('without a host override the chat opens with the generic hand-off', async () => {
        const r = render(<Host />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        fireEvent.press(r.getByTestId('tree-chat'));
        dismiss();
        expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
    });

    it('a browse_related nudge commits the path and goes to the host, after the sheet closes', async () => {
        const onBrowseRelated = jest.fn();
        const picked = jest.fn();
        const r = render(<Host onBrowseRelated={onBrowseRelated} onLeafPicked={picked} />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        fireEvent.press(r.getByTestId('tree-browse'));
        expect(picked).toHaveBeenCalledWith('like', ['rel'], 0, true);
        dismiss();
        expect(onBrowseRelated).toHaveBeenCalledWith('like');
        expect(mockToastShow).not.toHaveBeenCalled();
    });

    it('a host context resolver replaces the card-level context', async () => {
        const resolveTreeContext = jest.fn(async () => ({ articleTitle: 'from host', entity: 'NATO' }));
        const r = render(<Host resolveTreeContext={resolveTreeContext} />);
        fireEvent.press(r.getByTestId('open-like-tree'));
        await settle();
        expect(JSON.parse(r.getByTestId('tree-context').props.children)).toMatchObject({ entity: 'NATO' });
    });
});

// The Undo toast names the leaf exactly as its row did: the shared labeller,
// with this article's context (its variables filled), not the raw default.
it('the applied leaf is summarised by the shared labeller, with the article context', async () => {
    const resolveTreeContext = jest.fn(async () => ({ articleTitle: 'x', entity: 'NATO' }));
    const r = render(<Host resolveTreeContext={resolveTreeContext} />);
    fireEvent.press(r.getByTestId('open-like-tree'));
    await settle();
    fireEvent.press(r.getByTestId('tree-apply'));
    dismiss();
    await settle();
    expect(mockApplyLeaf).toHaveBeenCalledWith(expect.any(Array), 'label:less_entity:NATO', {
        articleId: 'art-1',
        sentiment: 'like',
    });
});


// Batch 12 fix 2: the outgoing level slides OUT while the new one slides in
// (push: old exits left, new enters from the right; Back: the reverse), so
// the sheet never shows an empty frame between levels. Reduce Motion swaps.
describe('the level transition', () => {
    const { SHEET_SLIDE_MS } = require('../ArticleOverflowMenu');
    const { AccessibilityInfo, StyleSheet } = jest.requireActual('react-native');
    const row = () => ({
        liked: false,
        saved: false,
        onLike: jest.fn(),
        onDislike: jest.fn(),
        onToggleSave: jest.fn(),
        onShare: jest.fn(),
    });
    // The outgoing copy is hidden from VoiceOver (it is leaving), and RNTL
    // skips hidden elements unless asked.
    const HIDDEN = { includeHiddenElements: true };
    afterEach(() => jest.restoreAllMocks());

    it('keeps the outgoing level on screen, sliding out, until the new one has landed', async () => {
        const r = openMenu(<Host rowActions={row()} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        // Both mounted mid-slide: the old rows ride out, the tree rides in.
        const out = r.getByTestId('article-menu-level-out', HIDDEN);
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
        expect(out.props.pointerEvents).toBe('none');
        // Absolutely placed, so the sheet sizes to the incoming level only.
        expect(StyleSheet.flatten(out.props.style)).toEqual(expect.objectContaining({ position: 'absolute' }));
        act(() => {
            jest.advanceTimersByTime(SHEET_SLIDE_MS + 100);
        });
        expect(r.queryByTestId('article-menu-level-out', HIDDEN)).toBeNull();
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
    });

    // Batch 13: on a push to a SHORTER level the sheet shrinks to the new
    // height while the outgoing rows are still sliding, and they spilled below
    // the sheet over Cancel for a frame. The viewport holding both levels clips.
    it('clips the sliding levels to their viewport, so outgoing rows never spill over Cancel', async () => {
        const r = openMenu(<Host rowActions={row()} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        const out = r.getByTestId('article-menu-level-out', HIDDEN);
        const viewport = r.getByTestId('article-menu-viewport');
        let inside = false;
        for (let p: any = out; p; p = p.parent) if (p === viewport) inside = true;
        expect(inside).toBe(true);
        expect(StyleSheet.flatten(viewport.props.style)).toEqual(expect.objectContaining({ overflow: 'hidden' }));
    });

    it('Back does the same in reverse, and the level it returns to is never blank', async () => {
        const r = openMenu(<Host rowActions={row()} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        act(() => {
            jest.advanceTimersByTime(SHEET_SLIDE_MS + 100);
        });
        fireEvent.press(r.getByTestId('sheet-back'));
        expect(r.getByTestId('article-menu-level-out', HIDDEN)).toBeTruthy();
        expect(r.getByTestId('menu-save')).toBeTruthy();
        act(() => {
            jest.advanceTimersByTime(SHEET_SLIDE_MS + 100);
        });
        expect(r.queryByTestId('article-menu-level-out', HIDDEN)).toBeNull();
        expect(r.getByTestId('menu-save')).toBeTruthy();
    });

    // Batch 14: on Back the sheet grew, and for ~100ms the short level sat at
    // the top of an empty tall sheet before the menu slid in. The height eases
    // IN STEP with the slide (same duration, an update only), and the incoming
    // level is never faded up from transparent (no LayoutAnimation `create`).
    it.each(['push', 'Back'])('on %s the height eases with the slide and the incoming level is not faded in', async (which) => {
        const { LayoutAnimation } = jest.requireActual('react-native');
        const r = openMenu(<Host rowActions={row()} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        act(() => {
            jest.advanceTimersByTime(SHEET_SLIDE_MS + 100);
        });
        const spy = jest.spyOn(LayoutAnimation, 'configureNext');
        if (which === 'Back') fireEvent.press(r.getByTestId('sheet-back'));
        else fireEvent.press(r.getByTestId('tree-descend'));
        expect(spy).toHaveBeenCalledTimes(1);
        const config = spy.mock.calls[0][0] as any;
        expect(config.duration).toBe(SHEET_SLIDE_MS);
        expect(config.update).toBeTruthy();
        expect(config.create).toBeUndefined();
    });

    it('Reduce Motion swaps levels in place, with no outgoing copy', async () => {
        jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
        const r = openMenu(<Host rowActions={row()} />);
        await settle();
        fireEvent.press(r.getByTestId('menu-like'));
        expect(r.queryByTestId('article-menu-level-out', HIDDEN)).toBeNull();
        expect(r.getByTestId('tree-like-root')).toBeTruthy();
    });
});

// Owner: "the bottom menus just appear. can they slide up and slide down?"
// The backdrop fades while the sheet slides from below the screen edge; every
// close runs the reverse. The Modal stays shown until the slide-down has
// FINISHED, so an item that presents native UI still runs only after the
// sheet has fully left (onDismiss on iOS, the exit's end on Android).
describe('the sheet slides up and down', () => {
    const { SHEET_ENTER_MS, SHEET_EXIT_MS } = require('../ArticleOverflowMenu');
    const { AccessibilityInfo, StyleSheet } = jest.requireActual('react-native');
    afterEach(() => jest.restoreAllMocks());

    it('animates the sheet itself: no Modal animation, a separate scrim and a sliding sheet', () => {
        const r = openMenu(<Host />);
        expect(mockModal.animationType).toBe('none');
        expect(r.getByTestId('article-menu-scrim')).toBeTruthy();
        const t = StyleSheet.flatten(r.getByTestId('article-menu-sheet').props.style)?.transform ?? [];
        expect(t.some((x: any) => 'translateY' in x)).toBe(true);
        expect(SHEET_ENTER_MS).toBe(250);
    });

    // Jest completes a native-driver animation on its first frame, so the
    // 250ms itself is not observable here; the ORDER is: the Modal is still
    // shown when the close is asked for, hides only when the slide-down
    // reports done, and the item runs only after the dismissal.
    it('keeps the Modal shown through the slide-down, then hides it; the item runs only after', () => {
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-open-source'));
        expect(mockModal.visible).toBe(true);
        expect(mockOpenOnSource).not.toHaveBeenCalled();
        act(() => {
            jest.advanceTimersByTime(SHEET_EXIT_MS + 50);
        });
        expect(mockModal.visible).toBe(false);
        expect(mockOpenOnSource).not.toHaveBeenCalled();
        dismiss();
        expect(mockOpenOnSource).toHaveBeenCalledTimes(1);
    });

    it('on Android (no onDismiss) the item runs once the slide-down has finished, not before', () => {
        mockOS = 'android';
        const r = openMenu(<Host />);
        fireEvent.press(r.getByTestId('menu-open-source'));
        expect(mockModal.visible).toBe(true);
        expect(mockOpenOnSource).not.toHaveBeenCalled();
        exitSheet();
        expect(r.queryByTestId('article-menu')).toBeNull();
        expect(mockOpenOnSource).toHaveBeenCalledTimes(1);
    });

    it('Reduce Motion fades the sheet without sliding it', async () => {
        jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
        const r = render(<Host />);
        fireEvent.press(r.getByTestId('open'));
        await settle();
        const t = StyleSheet.flatten(r.getByTestId('article-menu-sheet').props.style)?.transform ?? [];
        expect(t.some((x: any) => 'translateY' in x)).toBe(false);
    });
});
