import { readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToHex, verifyAttestation } from '../attestation-verify';
import {
  canonicalJson,
  checkDeployedSoftware,
  traceProxyImage,
  type ComposeFileFetcher,
} from '../deployed-software';
import report from '@/test/fixtures/attestation/compose-manager-report.json';

const FIXTURES = join(__dirname, '../../../test/fixtures/attestation');
const realFile = (name: string) =>
  gunzipSync(readFileSync(join(FIXTURES, name))).toString('utf8');

const COMMIT_NEWEST = '81da1f6290a2bdb2f8f7712ab8ca76c891f5660d';
const COMMIT_PROXY_UP = '75d31e6461dc51465a81ff69203200a51a820d1c';
const NOW = new Date('2026-11-06T09:45:00Z');
const MODEL = report.model_name;
const cm = report.compose_manager_attestation;

const realFiles: Record<string, string> = {
  [COMMIT_NEWEST]: realFile('compose-small-models-81da1f6.yaml.gz'),
  [COMMIT_PROXY_UP]: realFile('compose-small-models-75d31e6.yaml.gz'),
};
const realFetch = jest.fn<Promise<string | null>, [string, string]>(
  async commit => realFiles[commit] ?? null,
);

function flipHexByte(hex: string, byte: number): string {
  const at = byte * 2;
  const flipped = (parseInt(hex.slice(at, at + 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  return hex.slice(0, at) + flipped + hex.slice(at + 2);
}

/** Changes one base64 character inside the leaf certificate of the quote's PEM chain. */
function breakLeafCertificate(quoteHex: string): string {
  const pem = Buffer.from(quoteHex, 'hex');
  const at = pem.indexOf('-----BEGIN CERTIFICATE-----') + 300;
  pem[at] = pem[at] === 0x41 ? 0x42 : 0x41;
  return pem.toString('hex');
}

const run = (
  overrides: Partial<Parameters<typeof checkDeployedSoftware>[0]> = {},
  fetchFile: ComposeFileFetcher = realFetch,
) =>
  checkDeployedSoftware(
    {
      composeManagerAttestation: cm,
      modelQuoteHex: report.intel_quote,
      modelName: MODEL,
      expectedNonce: report.request_nonce,
      now: NOW,
      ...overrides,
    },
    fetchFile,
  );

beforeEach(() => realFetch.mockClear());

describe('checkDeployedSoftware: a real NEAR report', () => {
  it('passes and names the proxy image the file that started it pins', async () => {
    const result = await run();

    expect(result).toEqual({
      status: 'pass',
      detail:
        'nearaidev/vllm-proxy-rs@sha256:0be4ee8f40a2, from prod/small-models.yaml at 75d31e6461dc',
    });
    expect(realFetch.mock.calls).toEqual([
      [COMMIT_NEWEST, 'prod/small-models.yaml'],
      [COMMIT_PROXY_UP, 'prod/small-models.yaml'],
    ]);
  });

  it('keeps the verdict incomplete even on a pass', async () => {
    const deployedSoftware = await run();
    const { verdict } = verifyAttestation({
      quoteHex: report.intel_quote,
      signingPublicKey: report.signing_public_key,
      signingAlgo: 'ed25519',
      expectedNonce: report.request_nonce,
      deployedSoftware,
      now: NOW,
    });
    expect(verdict).toBe('incomplete');
  });
});

describe('checkDeployedSoftware: proof of a bad log is a fail', () => {
  it.each([
    ['a nonce other than ours', { expectedNonce: 'ab'.repeat(32) }, 'freshness-nonce'],
    [
      'an actions_hash other than the quoted one',
      { composeManagerAttestation: { ...cm, actions_hash: 'ab'.repeat(32) } },
      'report-data-key',
    ],
    [
      'a broken quote signature under a valid chain',
      // The last byte of the quote signature, right after the 4-byte auth length.
      { composeManagerAttestation: { ...cm, quote: flipHexByte(cm.quote, 632 + 4 + 63) } },
      'quote-signature',
    ],
  ])('%s', async (_name, overrides, check) => {
    expect(await run(overrides)).toEqual({ status: 'fail', detail: `the log's quote failed ${check}` });
    expect(realFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['MRTD', 184],
    ['MRCONFIGID', 232],
    ['RTMR0', 376],
    ['RTMR3', 520],
  ])('a model quote with a different %s', async (_name, byte) => {
    expect(await run({ modelQuoteHex: flipHexByte(report.intel_quote, byte) })).toEqual({
      status: 'fail',
      detail: "the log's quote comes from a different machine than the model's",
    });
  });

  it('an altered log', async () => {
    const actions = cm.actions.map((a, i) => (i === 0 ? { ...a, action: 'compose_down' } : a));
    expect(await run({ composeManagerAttestation: { ...cm, actions } })).toEqual({
      status: 'fail',
      detail: "the deployment log doesn't match the hash in its quote",
    });
  });

  it('a compose file that is not the one the log hashed', async () => {
    const result = await run({}, async commit => `${realFiles[commit]}\n`);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain("doesn't match the hash in the signed log");
  });
});

describe('checkDeployedSoftware: what it cannot judge is not-checked', () => {
  it.each([
    ['no log at all', undefined],
    ['a null log', null],
    ['a log with no quote', { ...cm, quote: undefined }],
    ['a log with no actions', { ...cm, actions: undefined }],
    ['a malformed hash', { ...cm, actions_hash: 'nope' }],
    ['an oversized log', { ...cm, actions: new Array(5001).fill({}) }],
    ['an unparsable quote', { ...cm, quote: 'zz' }],
    ['a quote whose chain is broken', { ...cm, quote: breakLeafCertificate(cm.quote) }],
  ])('%s', async (_name, composeManagerAttestation) => {
    expect((await run({ composeManagerAttestation })).status).toBe('not-checked');
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('an unparsable model quote', async () => {
    expect((await run({ modelQuoteHex: 'zz' })).status).toBe('not-checked');
  });

  it('a file that cannot be fetched', async () => {
    expect(await run({}, async () => null)).toEqual({
      status: 'not-checked',
      detail: 'prod/small-models.yaml could not be fetched',
    });
  });

  it('a fetcher that throws', async () => {
    const result = await run({}, async () => {
      throw new Error('network');
    });
    expect(result.status).toBe('not-checked');
  });

  it('a model the file has no proxy for', async () => {
    expect((await run({ modelName: 'some/other-model' })).status).toBe('not-checked');
  });
});

describe('canonicalJson', () => {
  // Generated by python3: json.dumps(v, sort_keys=True, separators=(",",":"), ensure_ascii=False).
  const value = [
    { action: 'compose_up', file: 'café नमस्ते 😀', note: 'q"b\\s\nn\t\u0001' },
    { z: '1', a: '2', services: [' x'] },
  ];

  it('matches Python byte for byte, non-ASCII and control characters included', () => {
    const canonical = canonicalJson(value);

    expect(canonical).toBe(
      '[{"action":"compose_up","file":"café नमस्ते 😀","note":"q\\"b\\\\s\\nn\\t\\u0001"},{"a":"2","services":[" x"],"z":"1"}]',
    );
    expect(bytesToHex(sha256(utf8ToBytes(canonical)))).toBe(
      '58f25710e660d35cdedfec68e69c82362aea657450e0978c9e0616c5f99a5856',
    );
  });

  it("reproduces NEAR's real log hash", () => {
    expect(bytesToHex(sha256(utf8ToBytes(canonicalJson(cm.actions))))).toBe(cm.actions_hash);
  });
});

describe('traceProxyImage: synthetic logs', () => {
  const IMAGE = `nearaidev/vllm-proxy-rs@sha256:${'c'.repeat(64)}`;
  const MODEL_A = 'Qwen/Model-A';
  const FILE = 'prod/models.yaml';
  const commit = (n: number) => String(n).repeat(40);

  const anchored = (image = IMAGE) => `x-nvidia: &nvidia
  runtime: nvidia

x-proxy: &proxy
  image: ${image}
  <<: *nvidia

services:
  # the proxies
  proxy-a:
    <<: *proxy
    container_name: proxy-a
    environment:
      - MODEL_NAME=${MODEL_A}

  proxy-b:
    <<: *proxy
    environment:
      - MODEL_NAME=Qwen/Model-B

configs:
  note:
    content: |
      image: nearaidev/evil@sha256:${'d'.repeat(64)}
      - MODEL_NAME=${MODEL_A}
`;

  const hashOf = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));
  const up = (text: string, n = 1, services: string[] = ['proxy-a'], file = FILE) => ({
    action: 'compose_up',
    commit: commit(n),
    file,
    file_sha256: hashOf(text),
    services,
  });
  const fetchOf =
    (files: Record<string, string>): ComposeFileFetcher =>
    async (c, file) =>
      files[`${c}/${file}`] ?? null;
  const at = (n: number, file = FILE) => `${commit(n)}/${file}`;

  it('follows an anchor to the digest', async () => {
    const text = anchored();
    const result = await traceProxyImage([up(text)], MODEL_A, fetchOf({ [at(1)]: text }));
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('sha256:cccccccccccc');
  });

  it('reads an image with no anchor, and a local image beats a merged one', async () => {
    const text = anchored(`nearaidev/vllm-proxy-rs@sha256:${'e'.repeat(64)}`).replace(
      '    container_name: proxy-a',
      `    image: ${IMAGE}`,
    );
    const result = await traceProxyImage([up(text)], MODEL_A, fetchOf({ [at(1)]: text }));
    expect(result.detail).toContain('sha256:cccccccccccc');
  });

  it('accepts a whole-file compose_up, which names no services', async () => {
    const text = anchored();
    const result = await traceProxyImage([up(text, 1, [])], MODEL_A, fetchOf({ [at(1)]: text }));
    expect(result.status).toBe('pass');
  });

  it('uses the commit that started the service, not the newest', async () => {
    const old = anchored();
    const newest = anchored(`nearaidev/vllm-proxy-rs@sha256:${'f'.repeat(64)}`);
    const result = await traceProxyImage(
      [up(old, 1), up(newest, 2, ['proxy-b'])],
      MODEL_A,
      fetchOf({ [at(1)]: old, [at(2)]: newest }),
    );
    expect(result.detail).toContain('sha256:cccccccccccc');
  });

  it('skips the side file when choosing the newest file', async () => {
    const text = anchored();
    const result = await traceProxyImage(
      [up(text), up('other', 2, [], 'prod/sage-pull.yaml')],
      MODEL_A,
      fetchOf({ [at(1)]: text }),
    );
    expect(result.status).toBe('pass');
  });

  it("ignores a stopped side file, and another service's stop", async () => {
    const text = anchored();
    const result = await traceProxyImage(
      [
        up(text),
        { action: 'compose_down', file: 'prod/sage-pull.yaml', services: [] },
        { action: 'compose_down', file: FILE, services: ['proxy-b'] },
        { action: 'docker_restart', container: 'proxy-a' },
      ],
      MODEL_A,
      fetchOf({ [at(1)]: text }),
    );
    expect(result.status).toBe('pass');
  });

  it.each([
    ['a later compose_down of the service', { action: 'compose_down', file: FILE, services: ['proxy-a'] }],
    ['a later whole-file compose_down', { action: 'compose_down', file: FILE, services: [] }],
  ])('is not-checked after %s', async (_name, down) => {
    const text = anchored();
    expect(await traceProxyImage([up(text), down], MODEL_A, fetchOf({ [at(1)]: text }))).toEqual({
      status: 'not-checked',
      detail: 'the log shows proxy-a was stopped',
    });
  });

  it.each([
    ['an image pinned by tag only', anchored('nearaidev/vllm-proxy-rs:latest')],
    ['an image from someone else', anchored(`nearaidev/other@sha256:${'c'.repeat(64)}`)],
    ['an image set from the environment', anchored('${PROXY_IMAGE}')],
    ['an anchor that is not defined', anchored().replace('x-proxy: &proxy', 'x-proxy: &other')],
    ['a service with no image', anchored().replace('    <<: *proxy\n    container_name', '    container_name')],
    ['two proxies for the model', anchored().replace('Qwen/Model-B', MODEL_A)],
    ['a file with no services', 'version: 1\n'],
    ['a block scalar that only mentions the model', anchored().replace(`      - MODEL_NAME=${MODEL_A}\n\n`, '\n')],
  ])('is not-checked for %s', async (_name, text) => {
    const result = await traceProxyImage([up(text)], MODEL_A, fetchOf({ [at(1)]: text }));
    expect(result.status).toBe('not-checked');
  });

  it('is not-checked when the service never started', async () => {
    const text = anchored();
    const result = await traceProxyImage([up(text, 1, ['proxy-b'])], MODEL_A, fetchOf({ [at(1)]: text }));
    expect(result).toEqual({ status: 'not-checked', detail: 'the log never started proxy-a' });
  });

  it('is not-checked when the older file no longer has the service for this model', async () => {
    const old = anchored().replace(`MODEL_NAME=${MODEL_A}`, 'MODEL_NAME=Qwen/Model-C');
    const newest = anchored();
    const result = await traceProxyImage(
      [up(old, 1), up(newest, 2, ['proxy-b'])],
      MODEL_A,
      fetchOf({ [at(1)]: old, [at(2)]: newest }),
    );
    expect(result.status).toBe('not-checked');
  });

  it.each([
    ['no compose_up', [{ action: 'docker_restart', container: 'x' }]],
    ['a commit that is not a full hash', [{ action: 'compose_up', commit: 'abc', file: FILE, file_sha256: 'a'.repeat(64) }]],
    ['a file outside prod', [{ action: 'compose_up', commit: commit(1), file: '../x.yaml', file_sha256: 'a'.repeat(64) }]],
    ['a malformed file hash', [{ action: 'compose_up', commit: commit(1), file: FILE, file_sha256: 'nope' }]],
  ])('never fetches for %s', async (_name, actions) => {
    const fetchFile = jest.fn(async () => null);
    expect((await traceProxyImage(actions, MODEL_A, fetchFile)).status).toBe('not-checked');
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('is not-checked for a file over the limit, without hashing it as a failure', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const result = await traceProxyImage([up(big)], MODEL_A, fetchOf({ [at(1)]: big }));
    expect(result).toEqual({ status: 'not-checked', detail: `${FILE} is over the size limit` });
  });

  it('fails when the second file is not the hashed one', async () => {
    const old = anchored();
    const newest = anchored();
    const result = await traceProxyImage(
      [up(old, 1), up(newest, 2, ['proxy-b'])],
      MODEL_A,
      fetchOf({ [at(1)]: `${old}#`, [at(2)]: newest }),
    );
    expect(result.status).toBe('fail');
  });
});
