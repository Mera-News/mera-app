import { parseServiceAddress } from '@/lib/own-services/address';

describe('parseServiceAddress', () => {
  it('refuses a non-https scheme', () => {
    expect(parseServiceAddress('http://x')).toEqual({ ok: false, reason: 'not-https' });
  });

  it('refuses userinfo', () => {
    expect(parseServiceAddress('https://u:p@x')).toEqual({ ok: false, reason: 'userinfo' });
  });

  it('calls a non-http scheme or empty input invalid', () => {
    expect(parseServiceAddress('ftp://x')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServiceAddress('')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('trims and strips one trailing slash', () => {
    expect(parseServiceAddress('  https://x/v1/ ')).toEqual({ ok: true, url: 'https://x/v1', host: 'x' });
  });

  it('lower-cases scheme and host and keeps a port and path', () => {
    expect(parseServiceAddress('HTTPS://AI.Example:8443/v1/')).toEqual({
      ok: true,
      url: 'https://ai.example:8443/v1',
      host: 'ai.example',
    });
  });

  it('refuses a non-ASCII host, a bad port and spaces; accepts the xn-- form', () => {
    expect(parseServiceAddress('https://bücher.example')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServiceAddress('https://x:99999')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServiceAddress('https://x/a b')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServiceAddress('https://xn--bcher-kva.example')).toEqual({
      ok: true,
      url: 'https://xn--bcher-kva.example',
      host: 'xn--bcher-kva.example',
    });
  });

  it('finds userinfo with no password', () => {
    expect(parseServiceAddress('https://user@x')).toEqual({ ok: false, reason: 'userinfo' });
  });
});
