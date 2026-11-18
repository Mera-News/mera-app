import { failSecureStore, healSecureStore, secureStoreDump } from '../../helpers/storage';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { OWN_AI_KEY, OWN_NEWS_KEY } from '@/lib/own-services/keys';
import { reportSecrets, setReportSecrets } from '@/lib/own-services/report-secrets';
import { OwnServiceError } from '@/lib/own-services/gate';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  ownAiOn,
  ownAiState,
  recordOwnAiCheck,
  saveOwnAiFields,
  setOwnAiOn,
  type OwnAiConfig,
} from '@/lib/own-services/own-ai-state';
import {
  graphqlUrlFor,
  ownNewsOn,
  ownNewsRoute,
  ownNewsState,
  saveOwnNewsFields,
  type OwnNewsConfig,
} from '@/lib/own-services/own-news-state';

const ai = (over: Partial<OwnAiConfig> = {}): OwnAiConfig => ({
  v: 1,
  baseUrl: 'https://ai.own.test/v1',
  model: 'm1',
  key: 'ai-key-12345678',
  on: false,
  checkedAt: null,
  status: null,
  ...over,
});
const news = (over: Partial<OwnNewsConfig> = {}): OwnNewsConfig => ({
  v: 1,
  baseUrl: 'https://news.own.test',
  key: 'news-key-12345678',
  on: false,
  checkedAt: null,
  status: null,
  fields: null,
  ...over,
});

beforeEach(() => {
  ownAiState.resetMemory();
  ownNewsState.resetMemory();
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
});
afterEach(() => {
  setReportSecrets('ownAi', null);
  setReportSecrets('ownNews', null);
});

describe('own AI state', () => {
  it('hydrates to null when nothing is stored', async () => {
    await ownAiState.hydrate();
    expect(ownAiState.get()).toBeNull();
    expect(ownAiState.isHydrated()).toBe(true);
    expect(ownAiOn()).toBe(false);
  });

  it('reads a saved config back and holds its host and key as report secrets', async () => {
    await ownAiState.save(ai());
    ownAiState.resetMemory();
    expect(reportSecrets()).toEqual({ hosts: [], secrets: [] });
    await ownAiState.hydrate();
    expect(ownAiState.get()).toEqual(ai());
    expect(reportSecrets()).toEqual({ hosts: ['ai.own.test'], secrets: ['ai-key-12345678'] });
  });

  it('rejects on a failed read, stays unhydrated, and reads again once healed', async () => {
    await ownAiState.save(ai());
    ownAiState.resetMemory();
    failSecureStore(OWN_AI_KEY, 'get');
    await expect(ownAiState.hydrate()).rejects.toThrow('keychain failure');
    expect(ownAiState.isHydrated()).toBe(false);
    healSecureStore();
    await ownAiState.hydrate();
    expect(ownAiState.get()?.model).toBe('m1');
  });

  it('refuses to turn on unchecked or while on-device, and persists nothing', async () => {
    await ownAiState.save(ai());
    await expect(setOwnAiOn(true)).rejects.toMatchObject({ code: 'not-checked' });
    await recordOwnAiCheck('connected');
    const before = secureStoreDump()[OWN_AI_KEY];
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
    await expect(setOwnAiOn(true)).rejects.toBeInstanceOf(OwnServiceError);
    await expect(setOwnAiOn(true)).rejects.toMatchObject({ code: 'on-device' });
    expect(secureStoreDump()[OWN_AI_KEY]).toBe(before);
    expect(ownAiOn()).toBe(false);
  });

  it('turns off on an edit of address, model or key, and keeps on when nothing changed', async () => {
    const on = ai({ on: true, status: 'connected', checkedAt: 5 });
    await ownAiState.save(on);
    await saveOwnAiFields({ baseUrl: on.baseUrl, model: on.model, key: on.key });
    expect(ownAiState.get()).toEqual(on);
    for (const edit of [{ baseUrl: 'https://other.test/v1' }, { model: 'm2' }, { key: null }]) {
      await ownAiState.save(on);
      await saveOwnAiFields({ baseUrl: on.baseUrl, model: on.model, key: on.key, ...edit });
      expect(ownAiState.get()).toMatchObject({ on: false, status: null, checkedAt: null });
    }
  });

  it('refuses a non-https address', async () => {
    await expect(saveOwnAiFields({ baseUrl: 'http://x', model: 'm', key: null })).rejects.toMatchObject({
      code: 'address',
      reason: 'not-https',
    });
  });

  it('turning on aborts any gateway run, so the pipeline stamps a finished run', async () => {
    useForYouStore.setState({ lastProcessingRunFinishedAt: null });
    await ownAiState.save(ai({ status: 'connected' }));
    await setOwnAiOn(true);
    expect(ownAiOn()).toBe(true);
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
  });

  it('trusts a saved value at once, and a read started before the save never lands over it', async () => {
    await ownAiState.save(ai({ model: 'old' }));
    ownAiState.resetMemory();
    const reading = ownAiState.hydrate();
    await ownAiState.save(ai({ model: 'new' }));
    await reading;
    expect(ownAiState.isHydrated()).toBe(true);
    expect(ownAiState.get()?.model).toBe('new');
  });

  it('keeps the switch on when a check fails', async () => {
    await ownAiState.save(ai({ on: true, status: 'connected' }));
    await recordOwnAiCheck('unreachable');
    expect(ownAiOn()).toBe(true);
    expect(ownAiState.get()?.status).toBe('unreachable');
  });
});

describe('own news state', () => {
  it('hydrates to null when nothing is stored', async () => {
    await ownNewsState.hydrate();
    expect(ownNewsState.get()).toBeNull();
    expect(ownNewsOn()).toBe(false);
    expect(ownNewsRoute()).toBeNull();
  });

  it('reads a saved config back and holds its host and key as report secrets', async () => {
    await ownNewsState.save(news({ on: true }));
    ownNewsState.resetMemory();
    await ownNewsState.hydrate();
    expect(ownNewsRoute()).toEqual({ graphqlUrl: 'https://news.own.test/graphql', key: 'news-key-12345678' });
    expect(reportSecrets()).toEqual({ hosts: ['news.own.test'], secrets: ['news-key-12345678'] });
  });

  it('rejects on a failed read and reads again once healed', async () => {
    await ownNewsState.save(news());
    ownNewsState.resetMemory();
    failSecureStore(OWN_NEWS_KEY, 'get');
    await expect(ownNewsState.hydrate()).rejects.toThrow('keychain failure');
    expect(ownNewsState.isHydrated()).toBe(false);
    healSecureStore();
    await ownNewsState.hydrate();
    expect(ownNewsState.get()?.baseUrl).toBe('https://news.own.test');
  });

  it('turns off on an edit and keeps on when nothing changed', async () => {
    const on = news({ on: true, status: 'connected', checkedAt: 5 });
    await ownNewsState.save(on);
    await saveOwnNewsFields({ baseUrl: on.baseUrl, key: on.key });
    expect(ownNewsState.get()).toEqual(on);
    await saveOwnNewsFields({ baseUrl: 'https://n2.test', key: on.key });
    expect(ownNewsState.get()).toMatchObject({ on: false, status: null, checkedAt: null });
  });

  it('builds the graphql url', () => {
    expect(graphqlUrlFor('https://n.test')).toBe('https://n.test/graphql');
    expect(graphqlUrlFor('https://n.test/graphql')).toBe('https://n.test/graphql');
  });
});
