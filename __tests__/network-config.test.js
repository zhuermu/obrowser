/**
 * Tests for the proxy/TLS setup that makes the Node-side cloud SDKs work on
 * networks where the provider is only reachable through a local proxy.
 */

const { parseResolvedProxy, chooseProxy, applyNetworkConfig } = require('../network-config');

describe('parseResolvedProxy', () => {
  test.each([
    ['DIRECT', null],
    ['', null],
    [undefined, null],
    ['PROXY 127.0.0.1:7890', 'http://127.0.0.1:7890'],
    ['PROXY proxy.corp:3128', 'http://proxy.corp:3128'],
    ['HTTPS secure.corp:443', 'https://secure.corp:443'],
    // First usable entry of a fallback list wins.
    ['PROXY a.corp:1;PROXY b.corp:2', 'http://a.corp:1'],
    ['DIRECT;PROXY b.corp:2', 'http://b.corp:2']
  ])('%s -> %s', (input, expected) => {
    expect(parseResolvedProxy(input)).toBe(expected);
  });

  test('SOCKS proxies are ignored rather than turned into a bad http:// URL', () => {
    // The Node proxy agents used by the SDKs speak HTTP CONNECT, not SOCKS.
    expect(parseResolvedProxy('SOCKS5 127.0.0.1:7890')).toBeNull();
    expect(parseResolvedProxy('SOCKS 127.0.0.1:1080')).toBeNull();
    // ...but a usable HTTP entry later in the list is still picked up.
    expect(parseResolvedProxy('SOCKS5 127.0.0.1:7890;PROXY 127.0.0.1:7890'))
      .toBe('http://127.0.0.1:7890');
  });

  test('malformed entries are skipped', () => {
    expect(parseResolvedProxy('PROXY')).toBeNull();
    expect(parseResolvedProxy('PROXY nohost')).toBeNull();
    expect(parseResolvedProxy('PROXY host:notaport')).toBeNull();
  });
});

describe('chooseProxy', () => {
  test('an explicit environment variable wins over the system setting', () => {
    const result = chooseProxy({ HTTPS_PROXY: 'http://env:1' }, 'http://system:2');
    expect(result).toEqual({ proxyUrl: 'http://env:1', source: 'environment' });
  });

  test('lowercase environment variables are honoured too', () => {
    expect(chooseProxy({ https_proxy: 'http://env:1' }, null).proxyUrl).toBe('http://env:1');
    expect(chooseProxy({ http_proxy: 'http://env:2' }, null).proxyUrl).toBe('http://env:2');
  });

  test('the system proxy is used when nothing is exported', () => {
    // This is the Finder-launch case, where no shell environment is inherited.
    expect(chooseProxy({}, 'http://system:2'))
      .toEqual({ proxyUrl: 'http://system:2', source: 'system' });
  });

  test('direct connection when neither is present', () => {
    expect(chooseProxy({}, null)).toEqual({ proxyUrl: null, source: 'none' });
  });
});

describe('applyNetworkConfig', () => {
  test('publishes the proxy for the SDK agents and caps TLS', () => {
    const env = {};
    const tlsModule = { DEFAULT_MAX_VERSION: 'TLSv1.3' };

    const result = applyNetworkConfig({ proxyUrl: 'http://127.0.0.1:7890', env, tlsModule });

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.https_proxy).toBe('http://127.0.0.1:7890');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.http_proxy).toBe('http://127.0.0.1:7890');
    // Electron's BoringSSL raises BAD_DECRYPT tearing down a proxied TLS 1.3
    // connection, which the Google SDK reports as a failed request.
    expect(tlsModule.DEFAULT_MAX_VERSION).toBe('TLSv1.2');
    expect(result).toEqual({ proxy: 'http://127.0.0.1:7890', tlsMaxVersion: 'TLSv1.2' });
  });

  test('loopback and the metadata server bypass the proxy', () => {
    const env = {};
    applyNetworkConfig({ proxyUrl: 'http://127.0.0.1:7890', env, tlsModule: {} });

    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.NO_PROXY).toContain('localhost');
    // Otherwise GCE metadata detection would be tunnelled through the proxy.
    expect(env.NO_PROXY).toContain('metadata.google.internal');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test('existing environment values are never overwritten', () => {
    const env = { HTTPS_PROXY: 'http://keep:1', NO_PROXY: 'keep.example' };
    applyNetworkConfig({ proxyUrl: 'http://other:2', env, tlsModule: {} });

    expect(env.HTTPS_PROXY).toBe('http://keep:1');
    expect(env.NO_PROXY).toBe('keep.example');
    // Unset ones still get filled in.
    expect(env.HTTP_PROXY).toBe('http://other:2');
  });

  test('a direct connection leaves TLS and the environment untouched', () => {
    const env = {};
    const tlsModule = { DEFAULT_MAX_VERSION: 'TLSv1.3' };

    const result = applyNetworkConfig({ proxyUrl: null, env, tlsModule });

    expect(env).toEqual({});
    expect(tlsModule.DEFAULT_MAX_VERSION).toBe('TLSv1.3');
    expect(result.proxy).toBeNull();
  });
});
