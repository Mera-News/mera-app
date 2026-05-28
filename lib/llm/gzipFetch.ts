// gzipFetch — thin wrapper over authFetch that gzips request bodies above
// a small threshold. Used for the async-inference POST where payloads are
// typically ~150 KB–1 MB and Cloud Run's request-body limit applies to the
// DECOMPRESSED size (50 MB). Server's body-parser auto-inflates.

import pako from 'pako';
import { authFetch } from './cloudComplete';

const MIN_GZIP_BYTES = 4 * 1024;

export async function gzipFetch(
  url: string,
  init: RequestInit & { body?: string },
): Promise<Response> {
  const body = init.body ?? '';
  const byteLength =
    typeof body === 'string' ? new TextEncoder().encode(body).length : 0;

  const headers = new Headers(init.headers ?? {});

  if (byteLength < MIN_GZIP_BYTES) {
    headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
    return authFetch(url, { ...init, headers });
  }

  const gzipped = pako.gzip(body);
  headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');
  headers.set('Content-Encoding', 'gzip');

  return authFetch(url, {
    ...init,
    headers,
    // expo/fetch accepts Uint8Array bodies; avoid copying to Buffer.
    body: gzipped as unknown as BodyInit,
  });
}
