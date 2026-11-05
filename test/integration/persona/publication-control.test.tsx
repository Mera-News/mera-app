// The publication page's control at its seam: the real hook and writers on the in-memory database, the catalogue
// faked at GraphQL. Three controls (Preferred, Not preferred, Subscribed); a stored Fewer reads as neither.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { InheritedStarHelp } from '@/components/custom/publication-preferences/PublicationControlRow';
import PublicationFeedControl from '@/components/custom/publication-page/PublicationFeedControl';
import { usePublicationPref } from '@/components/custom/publication-page/publication-data';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getPreferenceKind, setPreferenceKind, setScopePreferenceKind } from '@/lib/database/services/publication-preference-service';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});

const NAMES = ['Der Spiegel', 'Spiegel Wirtschaft'];

const Harness: React.FC = () => {
    const pref = usePublicationPref({ publisherId: 'pub-1', rawName: 'Der Spiegel', publisherName: 'Der Spiegel', sourceNames: NAMES }, 'DEU');
    const [helpCountry, setHelp] = React.useState<string | null>(null);
    return (
        <>
            <PublicationFeedControl
                testID="control"
                current={pref.level}
                muted={pref.muted}
                inheritedFrom={pref.inheritedFrom}
                onInheritedPress={() => setHelp(pref.inheritedFrom)}
                subscribed={false}
                canSubscribe
                onToggleSubscribed={() => undefined}
                busy={pref.busy || pref.names.length === 0}
                onChange={pref.change}
            />
            <InheritedStarHelp country={helpCountry} onClose={() => setHelp(null)} />
        </>
    );
};

const up = () => screen.getByTestId('publication-pref-up');
const mute = () => screen.getByTestId('publication-pref-mute');
const kinds = () => Promise.all(NAMES.map(getPreferenceKind));
const ready = () => waitFor(() => expect(up().props.accessibilityState).toMatchObject({ disabled: false }));
const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
    await act(async () => {
        await fireEvent.press(el);
    });
    await settleWrites();
};

let logs: ReturnType<typeof quietLogger>;
let undoToast: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(() => {
    logs = quietLogger();
    resetPublisherSourceNames();
    undoToast = jest.spyOn(toastManager, 'showUndoToast').mockImplementation(() => undefined);
});
afterEach(async () => {
    await settleWrites();
    undoToast.mockRestore();
    logs.restore();
});

describe('the publication page control', () => {
    it('has three controls: Preferred, Not preferred and Subscribed, with no Fewer', async () => {
        await render(<Harness />);
        await ready();
        expect(up()).toBeTruthy();
        expect(mute()).toBeTruthy();
        expect(screen.getByTestId('publication-pref-subscribed')).toBeTruthy();
        expect(screen.queryByTestId('publication-pref-down')).toBeNull();
        expect(screen.getByText('Preferred', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.getByText('Not preferred', { includeHiddenElements: true })).toBeTruthy();
    });

    it('a stored Fewer reads as neither Preferred nor Not preferred and keeps its row', async () => {
        await setPreferenceKind('Der Spiegel', 'deprioritize', 'user');
        await render(<Harness />);
        await ready();
        expect(up().props.accessibilityState).toMatchObject({ selected: false });
        expect(mute().props.accessibilityState).toMatchObject({ selected: false });
        expect(await getPreferenceKind('Der Spiegel')).toBe('deprioritize');
    });

    it('Not preferred shows Undo with an onClosed for the purge', async () => {
        await render(<Harness />);
        await ready();
        await press(mute());
        await waitFor(async () => expect(await kinds()).toEqual(['mute', 'mute']));
        expect(undoToast).toHaveBeenCalledTimes(1);
        expect(typeof undoToast.mock.calls[0][0].onClosed).toBe('function');
    });

    it('an inherited star is selected, opens help and writes nothing', async () => {
        await setScopePreferenceKind({ scopeKind: 'country', scopeValue: 'DEU' }, 'boost', 'Germany', 'user');
        await render(<Harness />);
        await waitFor(() => expect(up().props.accessibilityState).toMatchObject({ selected: true }));
        await press(up());
        expect(await kinds()).toEqual(['none', 'none']);
        expect(screen.getByText('Included with Germany. To change this, remove the star from Germany.')).toBeTruthy();
    });
});

describe('a tap before the profile has answered', () => {
    // The page mounts knowing one name; the full set arrives with the profile.
    const Cold: React.FC = () => {
        const pref = usePublicationPref({ publisherId: 'pub-1', rawName: 'Der Spiegel' });
        return (
            <PublicationFeedControl
                current={pref.level}
                muted={pref.muted}
                subscribed={false}
                canSubscribe
                onToggleSubscribed={() => undefined}
                busy={pref.busy || pref.names.length === 0}
                onChange={pref.change}
            />
        );
    };

    it('still writes every name', async () => {
        server.use(
            mockGql('PublicationSourcesForNewsPublisher', {
                publicationSourcesForNewsPublisher: {
                    __typename: 'PublicationSourcesForPublisherResponse',
                    publicationSources: NAMES.map((publication_name, i) => ({ __typename: 'PublicationSource', _id: `s${i}`, publication_name })),
                },
            }),
        );
        await render(<Cold />);
        await ready();
        await press(up());
        await waitFor(async () => expect(await kinds()).toEqual(['boost', 'boost']));
    });

    it('refuses the write when the names cannot be fetched', async () => {
        const info = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => undefined);
        server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'down'));
        await render(<Cold />);
        await ready();
        await press(up());
        await waitFor(() => expect(info).toHaveBeenCalledWith("Couldn't save that. Try again."));
        expect(await kinds()).toEqual(['none', 'none']);
        info.mockRestore();
    });
});
