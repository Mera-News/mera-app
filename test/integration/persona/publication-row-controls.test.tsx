// The shared source row at its seam: the real hook, the real writer on the in-memory database, the catalogue
// faked at GraphQL. A search hit knows only part of a publication's names, so every write is checked per name.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import PublicationControlRow, { InheritedStarHelp } from '@/components/custom/publication-preferences/PublicationControlRow';
import { usePublicationRowPrefs, type RowPublisher } from '@/components/custom/publication-preferences/use-publication-row-prefs';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getPreferenceKind, getScopePreferenceKind, setScopePreferenceKind } from '@/lib/database/services/publication-preference-service';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});

const HIT: RowPublisher = { publisherId: 'pub-1', rawName: 'Der Spiegel', countryCode: 'DEU' };
const NAMES = ['Der Spiegel', 'Spiegel Wirtschaft'];
const GERMANY = { alpha2: 'DE', alpha3: 'DEU', label: 'Germany' };

const catalogue = () =>
    server.use(
        mockGql('PublicationSourcesForNewsPublisher', {
            publicationSourcesForNewsPublisher: {
                __typename: 'PublicationSourcesForPublisherResponse',
                publicationSources: [
                    { __typename: 'PublicationSource', _id: 's1', publication_name: 'Der Spiegel' },
                    { __typename: 'PublicationSource', _id: 's2', publication_name: 'Spiegel Wirtschaft' },
                ],
            },
        }),
    );

const Harness: React.FC<{ readonly withCountry?: boolean }> = ({ withCountry }) => {
    const prefs = usePublicationRowPrefs();
    return (
        <>
            <PublicationControlRow {...prefs.publisherRow(HIT)} rawName={HIT.rawName} onPress={() => undefined} testID="row" />
            {withCountry ? <PublicationControlRow {...prefs.countryRow(GERMANY)} rawName={GERMANY.label} testID="country" /> : null}
            <InheritedStarHelp country={prefs.helpCountry} onClose={prefs.closeHelp} />
        </>
    );
};

const star = () => screen.getByTestId('row-star');
const hide = () => screen.getByTestId('row-hide');
const kinds = () => Promise.all(NAMES.map(getPreferenceKind));
const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
    await act(async () => {
        await fireEvent.press(el);
    });
    await settleWrites();
};

let logs: ReturnType<typeof quietLogger>;
let undoToast: jest.SpyInstance;
let infoToast: jest.SpyInstance;

beforeAll(initI18nEn);
beforeEach(() => {
    logs = quietLogger();
    resetPublisherSourceNames();
    undoToast = jest.spyOn(toastManager, 'showUndoToast').mockImplementation(() => undefined);
    infoToast = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => undefined);
});
afterEach(async () => {
    await settleWrites();
    undoToast.mockRestore();
    infoToast.mockRestore();
    logs.restore();
});

describe('star and Not preferred on a publication row', () => {
    it('writes every name on an empty name cache, not only the name the hit showed', async () => {
        catalogue();
        await render(<Harness />);
        await press(star());
        await waitFor(async () => expect(await kinds()).toEqual(['boost', 'boost']));
        expect(star().props.accessibilityState).toMatchObject({ selected: true });
    });

    it('refuses the write and says so when the names cannot be fetched', async () => {
        server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'down'));
        await render(<Harness />);
        await press(star());
        expect(await kinds()).toEqual(['none', 'none']);
        expect(infoToast).toHaveBeenCalledWith("Couldn't save that. Try again.");
        expect(star().props.accessibilityState).toMatchObject({ selected: false });
    });

    it('tapping a set star clears it, on every name', async () => {
        catalogue();
        await render(<Harness />);
        await press(star());
        await press(star());
        await waitFor(async () => expect(await kinds()).toEqual(['none', 'none']));
    });

    it('the two exclude each other, in both directions', async () => {
        catalogue();
        await render(<Harness />);
        await press(star());
        await press(hide());
        await waitFor(async () => expect(await kinds()).toEqual(['mute', 'mute']));
        await waitFor(() => expect(star().props.accessibilityState).toMatchObject({ selected: false }));
        expect(hide().props.accessibilityState).toMatchObject({ selected: true });
        await press(star());
        await waitFor(async () => expect(await kinds()).toEqual(['boost', 'boost']));
        expect(hide().props.accessibilityState).toMatchObject({ selected: false });
    });

    it('Not preferred shows Undo before any purge, and Undo puts the star back', async () => {
        catalogue();
        await render(<Harness />);
        await press(star());
        await press(hide());
        expect(undoToast).toHaveBeenCalledTimes(1);
        const opts = undoToast.mock.calls[0][0];
        expect(opts.title).toBe('Der Spiegel is hidden from your feed');
        expect(typeof opts.onClosed).toBe('function');
        await act(async () => {
            expect(await opts.onUndo()).toBe(true);
        });
        await settleWrites();
        await waitFor(async () => expect(await kinds()).toEqual(['boost', 'boost']));
    });

    it('clearing Not preferred shows no toast', async () => {
        catalogue();
        await render(<Harness />);
        await press(hide());
        undoToast.mockClear();
        await press(hide());
        await waitFor(async () => expect(await kinds()).toEqual(['none', 'none']));
        expect(undoToast).not.toHaveBeenCalled();
    });
});

describe('a preferred country', () => {
    it('the star writes one country row and clearing it offers Undo', async () => {
        await render(<Harness withCountry />);
        await press(screen.getByTestId('country-star'));
        await waitFor(async () =>
            expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: 'DEU' })).toBe('boost'),
        );
        await press(screen.getByTestId('country-star'));
        await waitFor(async () =>
            expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: 'DEU' })).toBe('none'),
        );
        const opts = undoToast.mock.calls[0][0];
        expect(opts.title).toBe('Germany is no longer preferred');
        await act(async () => {
            await opts.onUndo();
        });
        await waitFor(async () =>
            expect(await getScopePreferenceKind({ scopeKind: 'country', scopeValue: 'DEU' })).toBe('boost'),
        );
    });

    it('has no Not preferred control', async () => {
        await render(<Harness withCountry />);
        expect(screen.queryByTestId('country-hide')).toBeNull();
    });

    it('its publications inherit a star that opens help and writes nothing, and can still be hidden', async () => {
        catalogue();
        await setScopePreferenceKind({ scopeKind: 'country', scopeValue: 'DEU' }, 'boost', 'Germany', 'user');
        await render(<Harness />);
        await waitFor(() => expect(screen.getByTestId('row').props.accessibilityLabel).toBe('Der Spiegel, Included with Germany'));
        expect(star().props.accessibilityLabel).toBe('Preferred, included with Germany');
        await press(star());
        expect(await kinds()).toEqual(['none', 'none']);
        expect(screen.getByText('Included with Germany. To change this, remove the star from Germany.')).toBeTruthy();
        await press(hide());
        await waitFor(async () => expect(await kinds()).toEqual(['mute', 'mute']));
        await waitFor(() => expect(screen.getByTestId('row').props.accessibilityLabel).toBe('Der Spiegel'));
        expect(hide().props.accessibilityState).toMatchObject({ selected: true });
    });
});

describe('the row', () => {
    it('keeps the controls out of the body press, with their own 44pt frames, labels and hint', async () => {
        const open = jest.fn();
        catalogue();
        const Row = () => {
            const prefs = usePublicationRowPrefs();
            return <PublicationControlRow {...prefs.publisherRow(HIT)} rawName={HIT.rawName} onPress={open} testID="row" />;
        };
        await render(<Row />);
        await press(star());
        expect(open).not.toHaveBeenCalled();
        await press(screen.getByTestId('row'));
        expect(open).toHaveBeenCalledTimes(1);
        const frame = StyleSheet.flatten(screen.getByTestId('row-star-frame').props.style);
        expect(frame).toMatchObject({ width: 44, height: 44 });
        expect(hide().props.accessibilityLabel).toBe('Mark Der Spiegel as not preferred');
        expect(hide().props.accessibilityHint).toBe('Hides its articles from your feed');
    });

    it('with no onPress the body is not a button', async () => {
        const Row = () => {
            const prefs = usePublicationRowPrefs();
            return <PublicationControlRow {...prefs.publisherRow(HIT)} rawName={HIT.rawName} testID="row" />;
        };
        await render(<Row />);
        expect(screen.queryByTestId('row')).toBeNull();
        expect(screen.getByTestId('row-body').props.accessibilityRole).toBeUndefined();
    });
});
