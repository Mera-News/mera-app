// The own AI service page at its seams: the fields, the real check over MSW, the real stored state,
// the app's dialog host and the router. Nothing under the page is replaced.
import React from 'react';
import { router } from 'expo-router';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OwnAiServiceScreen from '@/components/custom/config-mera/own-services/OwnAiServiceScreen';
import WhatChangesScreen from '@/components/custom/config-mera/own-services/WhatChangesScreen';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { ownAiState, type OwnAiConfig } from '@/lib/own-services/own-ai-state';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import * as WebBrowser from 'expo-web-browser';
import { http, HttpResponse, initI18nEn, server } from '@/test/helpers';

const HOST = 'https://ai.own.test';
const CHECK_URL = `${HOST}/chat/completions`;

const answer = (status: number, body: unknown = {}) =>
    server.use(http.post(CHECK_URL, () => HttpResponse.json(body as never, { status })));
const unreachable = () => server.use(http.post(CHECK_URL, () => HttpResponse.error()));

const seed = (p: Partial<OwnAiConfig> = {}) =>
    ownAiState.save({ v: 1, baseUrl: HOST, model: 'm1', key: null, on: false, checkedAt: 1, status: 'connected', confirmed: null, ...p });

const mount = async () => {
    await render(<OwnAiServiceScreen />);
    // The stored state is read in before the fields show.
    await screen.findByTestId('own-ai-address');
};

const typeInto = async (id: string, text: string) => {
    await fireEvent.changeText(screen.getByTestId(id), text);
};
const sw = () => screen.getByTestId('own-ai-switch');
const flip = async (on: boolean) => {
    await fireEvent(sw(), 'valueChange', on);
};
const pressCheck = async () => {
    await fireEvent.press(screen.getByTestId('own-ai-check'));
};

/** The testIDs and texts of the tree, in render order. */
function order(node: unknown, out: string[] = []): string[] {
    if (node == null || typeof node === 'string') return out;
    if (Array.isArray(node)) return node.reduce<string[]>((acc, n) => order(n, acc), out);
    const n = node as { props?: { testID?: string }; children?: unknown };
    if (n.props?.testID) out.push(n.props.testID);
    return order(n.children, out);
}

beforeAll(initI18nEn);
beforeEach(() => {
    ownAiState.resetMemory();
    useDialogQueue.setState({ queue: [] });
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    jest.mocked(router.push).mockClear();
    jest.mocked(router.navigate).mockClear();
});

describe('own AI service page', () => {
    it('marks the service as Beta beside its intro', async () => {
        await mount();
        expect(screen.getByTestId('own-ai-beta')).toBeTruthy();
    });

    it('empty: Check and the switch are disabled', async () => {
        await mount();
        expect(screen.getByTestId('own-ai-check')).toBeDisabled();
        expect(sw()).toBeDisabled();
        await typeInto('own-ai-address', 'https://ai.own.test');
        expect(screen.getByTestId('own-ai-check')).toBeDisabled();
        await typeInto('own-ai-model', 'm1');
        expect(screen.getByTestId('own-ai-check')).toBeEnabled();
        expect(sw()).toBeDisabled();
    });

    it('http:// shows the not-https line and Check stays disabled', async () => {
        await mount();
        await typeInto('own-ai-address', 'http://ai.own.test');
        await typeInto('own-ai-model', 'm1');
        expect(screen.getByText('Use an address that starts with https://')).toBeTruthy();
        expect(screen.getByTestId('own-ai-check')).toBeDisabled();
    });

    it('a good check shows Connected and enables the switch; the first turn-on asks first', async () => {
        answer(200, { choices: [{ message: { content: 'OK' } }] });
        await mount();
        await typeInto('own-ai-address', 'https://ai.own.test');
        await typeInto('own-ai-model', 'm1');
        await pressCheck();
        expect(await screen.findByText('Connected')).toBeTruthy();
        expect(sw()).toBeEnabled();

        // The confirm goes through the app's dialog queue, which the root's host draws.
        await flip(true);
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        const ask = useDialogQueue.getState().queue[0];
        expect(ask.title).toBe('Use your own AI service?');
        expect(ask.body).toBe("Your profile, your chats and the articles Mera News reads for you go to this service. Whoever runs it can read them and decides how they are used. Mera Labs still can't see your profile or your chats.");
        expect(ask.confirmLabel).toBe('Use it');
        await act(async () => settleDialog(ask.id, false));
        expect(ownAiState.get()?.on).toBe(false);
        expect(sw().props.value).toBe(false);

        await flip(true);
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await act(async () => settleDialog(useDialogQueue.getState().queue[0].id, true));
        await waitFor(() => expect(ownAiState.get()?.on).toBe(true));
        expect(sw().props.value).toBe(true);
        // The confirmation is kept in the stored item, with no address or anything else of the person's.
        expect(ownAiState.get()?.confirmed).toEqual({ at: expect.any(Number), privacyVersion: null });

        // Off and on again at the same address: already confirmed, so no dialog.
        await flip(false);
        await waitFor(() => expect(ownAiState.get()?.on).toBe(false));
        await flip(true);
        await waitFor(() => expect(ownAiState.get()?.on).toBe(true));
        expect(useDialogQueue.getState().queue).toHaveLength(0);
    });

    it('the privacy policy link opens the own-services section in the in-app browser', async () => {
        await seed();
        await mount();
        await fireEvent.press(screen.getByTestId('own-ai-privacy'));
        expect(jest.mocked(WebBrowser.openBrowserAsync).mock.calls.at(-1)?.[0]).toMatch(/^https:\/\/mera\.news\/(en\/)?privacy#own-services$/);
    });

    it.each([
        ['refused', () => answer(401), 'The service refused this key.'],
        ['not-openai', () => answer(200, { hello: 1 }), "This address doesn't work with the OpenAI API."],
        ['no-model', () => answer(404, { error: { code: 'model_not_found' } }), "This model isn't on this service."],
        ['redirect', () => answer(302), 'This address redirects. Use the final address.'],
        ['busy', () => answer(429), 'This service is busy. Try again in a minute.'],
        ['failing', () => answer(500), 'This service had a problem. Try again later.'],
        ['unreachable', unreachable, "Can't reach this address."],
    ])('%s shows its line and the switch stays disabled', async (_name, arrange, line) => {
        arrange();
        await mount();
        await typeInto('own-ai-address', 'https://ai.own.test');
        await typeInto('own-ai-model', 'm1');
        await pressCheck();
        expect(await screen.findByText(line)).toBeTruthy();
        expect(sw()).toBeDisabled();
    });

    it('on, then a check that fails: says so and the switch stays on', async () => {
        await seed({ on: true, confirmed: { at: 1, privacyVersion: null } });
        unreachable();
        await mount();
        expect(sw().props.value).toBe(true);
        await pressCheck();
        expect(await screen.findByText("Last check failed. Can't reach this address.")).toBeTruthy();
        expect(sw().props.value).toBe(true);
        expect(ownAiState.get()?.on).toBe(true);
    });

    it('on, then an address edit: nothing moves until Check, which saves the new address and turns the switch off', async () => {
        await seed({ on: true, confirmed: { at: 1, privacyVersion: null } });
        await mount();
        await typeInto('own-ai-address', 'https://other.own.test');
        // Typing alone moves nothing: the stored service stays on and in use.
        expect(sw().props.value).toBe(true);
        expect(ownAiState.get()).toMatchObject({ on: true, baseUrl: 'https://ai.own.test' });
        // Typed and deleted again: still on, nothing silently changed.
        await typeInto('own-ai-address', 'https://ai.own.test');
        expect(ownAiState.get()?.on).toBe(true);

        await typeInto('own-ai-address', 'https://other.own.test');
        server.use(http.post('https://other.own.test/chat/completions', () => HttpResponse.json({ choices: [] })));
        await pressCheck();
        expect(await screen.findByText('Connected')).toBeTruthy();
        expect(ownAiState.get()).toMatchObject({ on: false, baseUrl: 'https://other.own.test' });
        expect(sw().props.value).toBe(false);
        expect(sw()).not.toBeDisabled();
    });

    it('with On this phone on: the switch is disabled, says why, and the button goes there', async () => {
        await seed();
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        await mount();
        expect(sw()).toBeDisabled();
        expect(sw().props.accessibilityHint).toBe('Turn off On this phone first.');
        expect(screen.getByText('Turn off On this phone first.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Go to On this phone'));
        expect(router.navigate).toHaveBeenCalledTimes(1);
    });

    it('the key field is secure until Show key, and the label then reads Hide key', async () => {
        await seed({ key: 'sk-secret-123' });
        await mount();
        expect(screen.getByTestId('own-ai-key').props.secureTextEntry).toBe(true);
        expect(screen.getByTestId('own-ai-key').props.autoComplete).toBe('off');
        expect(screen.queryByText('sk-secret-123')).toBeNull();
        await fireEvent.press(screen.getByText('Show key'));
        expect(screen.getByTestId('own-ai-key').props.secureTextEntry).toBe(false);
        expect(screen.getByText('Hide key')).toBeTruthy();
        await fireEvent.press(screen.getByText('Hide key'));
        expect(screen.getByTestId('own-ai-key').props.secureTextEntry).toBe(true);
    });

    it('address fields take the URL keyboard with no autocorrect', async () => {
        await mount();
        const a = screen.getByTestId('own-ai-address').props;
        expect(a.keyboardType).toBe('url');
        expect(a.autoCapitalize).toBe('none');
        expect(a.autoCorrect).toBe(false);
    });

    it('the warning sits above the switch, and What changes opens its page', async () => {
        await seed();
        await mount();
        const ids = order(screen.toJSON());
        expect(ids.indexOf('own-ai-warning')).toBeGreaterThan(-1);
        expect(ids.indexOf('own-ai-warning')).toBeLessThan(ids.indexOf('own-ai-switch'));
        await fireEvent.press(screen.getByTestId('own-ai-changes-row'));
        expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-ai-changes');
    });

    it('the status is a live region', async () => {
        await seed();
        await mount();
        expect(screen.getByTestId('own-ai-status').props.accessibilityLiveRegion).toBe('polite');
        await act(async () => {});
    });

    it('What changes says the three things that change, and nothing about a daily limit', async () => {
        await render(<WhatChangesScreen />);
        expect(screen.getByText('Ranking, reasons and chat use your service.')).toBeTruthy();
        expect(screen.getByText('Web search and fact checks are off.')).toBeTruthy();
        expect(screen.getByText('Verify attestation is hidden. It checks the private cloud only.')).toBeTruthy();
        expect(screen.queryByText(/daily limit/i)).toBeNull();
    });
});
