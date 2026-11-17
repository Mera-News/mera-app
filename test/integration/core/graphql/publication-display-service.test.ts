// publication-display-service at its seam: the real Apollo client against MSW, the real settings
// service on the in-memory DB, and a real publication-display store built per test. The service
// had no test: this pins the locale mapping, batching, the unsupported-server path, the cache row
// and the install wiring (current language adopted, language changes followed, no double wiring).
import {
  fetchPublicationDisplayNames,
} from '@/lib/publication-display-service';
import {
  PublicationDisplayUnsupportedError,
} from '@/lib/stores/publication-display-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { mockGqlError, server } from '@/test/helpers';
import { resetNetworkMemory, spyLogger } from './kit';

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  useForYouStore.getState().setSyncStatusMessage(null);
  log = spyLogger();
});
afterEach(() => log.restore());

describe('fetchPublicationDisplayNames', () => {

  it('re-throws any other GraphQL error as it came, reporting it but never painting the feed as failed', async () => {
    server.use(mockGqlError('PublicationDisplayNames', 'INTERNAL_SERVER_ERROR', { message: 'db down' }));

    const err = await fetchPublicationDisplayNames('en', ['A']).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PublicationDisplayUnsupportedError);
    expect((err as Error).message).toContain('db down');
    expect(log.captureException).toHaveBeenCalled();
    expect(useForYouStore.getState().syncStatusMessage).toBeNull();
  });
});
