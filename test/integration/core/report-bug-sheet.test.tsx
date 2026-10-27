// Report a bug: a bottom sheet with a message-only form, an optional prefilled draft, and
// anonymous prefilled reports. The SDK is ESM that this jest config does not transform, so
// FeedbackWidget is faked with the SDK's own draft behaviour (a static _savedState read on
// mount and written back on unmount) and a separate spec pins the real source for those names.
// The sheet primitive, auth and app-restart holds are faked at their edges.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { initI18nEn } from '@/test/helpers';

jest.mock('@sentry/react-native', () => {
    const R = jest.requireActual('react');
    const { TextInput } = jest.requireActual('react-native');
    const blank = () => ({ description: '' });
    class FeedbackWidget extends R.Component {
        static _savedState = blank();
        static reset() {
            FeedbackWidget._savedState = blank();
        }
        state = { description: FeedbackWidget._savedState.description };
        componentWillUnmount() {
            FeedbackWidget._savedState = { ...this.state };
        }
        render() {
            return R.createElement(TextInput, {
                value: this.state.description,
                onChangeText: (description: string) => this.setState({ description }),
                testID: 'widget-message',
                'data-show-email': String(this.props.showEmail),
            });
        }
    }
    return {
        init: jest.fn(),
        setContext: jest.fn(),
        setTag: jest.fn(),
        setUser: jest.fn(),
        captureException: jest.fn(),
        addBreadcrumb: jest.fn(),
        feedbackIntegration: jest.fn(() => ({ name: 'Feedback' })),
        breadcrumbsIntegration: jest.fn(() => ({ name: 'Breadcrumbs' })),
        FeedbackWidget,
    };
});
jest.mock('@/components/ui/bottom-sheet', () => {
    const R = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    return {
        BottomSheet: ({ open, onClosed, children }: { open: boolean; onClosed?: () => void; children: React.ReactNode }) => {
            const was = R.useRef(open);
            R.useEffect(() => {
                if (was.current && !open) onClosed?.();
                was.current = open;
            }, [open, onClosed]);
            return R.createElement(View, { testID: 'sheet' }, children);
        },
    };
});
jest.mock('@/lib/app-restart', () => ({ useRestartHold: () => {} }));
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: null }) } }));
jest.mock('@/lib/stores/user-store', () => ({ useUserStore: (sel: (s: { userId: string }) => unknown) => sel({ userId: 'user-1' }) }));
jest.mock('@/components/custom/MeraLogo', () => () => null);

type Feedback = typeof import('@/lib/feedback');
type Store = typeof import('@/lib/stores/feedback-store');
let Sentry: { init: jest.Mock };
let FeedbackWidgetModal: React.FC;
let feedback: Feedback;
let store: Store['useFeedbackStore'];

let processEvent: (e: Record<string, unknown>) => Record<string, unknown>;

// Sentry is on in this suite: sentry-init reads __DEV__ at import. Loaded once (a module
// reset would give the component a second copy of React).
beforeAll(async () => {
    await initI18nEn();
    (global as unknown as { __DEV__: boolean }).__DEV__ = false;
    Sentry = require('@sentry/react-native');
    require('@/lib/sentry-init');
    FeedbackWidgetModal = require('@/components/custom/FeedbackWidgetModal').default;
    feedback = require('@/lib/feedback');
    store = require('@/lib/stores/feedback-store').useFeedbackStore;
    const integrations = Sentry.init.mock.calls[0][0].integrations as Array<{ name: string; processEvent?: typeof processEvent }>;
    processEvent = integrations.find((i) => i.name === 'AnonymisePrefilledFeedback')!.processEvent!;
});
afterAll(() => {
    (global as unknown as { __DEV__: boolean }).__DEV__ = true;
});

const draft = () => (feedback.feedbackWidgetInternals() as unknown as { _savedState: { description: string } })._savedState.description;

it('pins the Sentry draft internals the prefill relies on (fails loudly on an SDK change)', () => {
    const src = fs.readFileSync(
        path.join(process.cwd(), 'node_modules/@sentry/react-native/dist/js/feedback/FeedbackWidget.js'),
        'utf8',
    );
    expect(src).toMatch(/FeedbackWidget\._savedState = \{[^}]*description: ''/);
    expect(src).toMatch(/static reset\(\)/);
    expect(src).toMatch(/description: FeedbackWidget\._savedState\.description/);
});

it('has no email field and seeds the message from a prefill', () => {
    render(<FeedbackWidgetModal />);
    act(() => feedback.showFeedback({ prefill: 'It crashed when I opened a story' }));
    expect(screen.getByDisplayValue('It crashed when I opened a story')).toBeTruthy();
    expect(screen.getByTestId('widget-message').props['data-show-email']).toBe('false');
    expect(screen.getByTestId('feedback-cancel')).toBeTruthy();
});

it('wipes an unsent prefilled draft once the sheet is gone, and keeps an ordinary draft', () => {
    render(<FeedbackWidgetModal />);
    act(() => feedback.showFeedback({ prefill: 'prefilled text' }));
    act(() => store.getState().hide());
    expect(store.getState().mounted).toBe(false);
    expect(draft()).toBe('');

    act(() => feedback.showFeedback());
    fireEvent.changeText(screen.getByTestId('widget-message'), 'my own words');
    act(() => store.getState().hide());
    expect(draft()).toBe('my own words');
});

it('Sentry off: nothing opens and nothing renders', () => {
    jest.isolateModules(() => {
        (global as unknown as { __DEV__: boolean }).__DEV__ = true;
        const off = require('@/lib/feedback') as Feedback;
        const offStore = (require('@/lib/stores/feedback-store') as Store).useFeedbackStore;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        off.showFeedback({ prefill: 'x' });
        warn.mockRestore();
        expect(offStore.getState().mounted).toBe(false);
    });
});

describe('the feedback event processor', () => {
    type Ev = { type?: string; user?: unknown; breadcrumbs?: unknown; tags?: unknown };
    const processor = () => processEvent as unknown as (e: Ev) => Ev;
    const report = (): Ev => ({ type: 'feedback', user: { id: 'u' }, breadcrumbs: [{}], tags: { a: '1' } });

    it('strips user, breadcrumbs and tags from a prefilled report, once', () => {
        feedback.showFeedback({ prefill: 'hello' });
        const first = processor()(report());
        expect(first).toEqual({ type: 'feedback' });
        expect(processor()(report()).user).toEqual({ id: 'u' });
    });

    it('keeps an ordinary report whole (support id rides the user)', () => {
        feedback.showFeedback();
        const ev = { ...report(), user: { id: 'u', support_id: '12345678' } };
        expect(processor()(ev).user).toEqual({ id: 'u', support_id: '12345678' });
    });

    it('leaves non-feedback events alone and keeps the flag for the feedback', () => {
        feedback.showFeedback({ prefill: 'hello' });
        const err = { type: undefined, user: { id: 'u' } } as Ev;
        expect(processor()(err).user).toEqual({ id: 'u' });
        expect(processor()(report()).user).toBeUndefined();
    });
});
