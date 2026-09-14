/**
 * Network configuration for the Node-side cloud SDKs.
 *
 * Two problems this solves, both found while testing Google Cloud Storage from
 * a network that requires a local proxy to reach Google:
 *
 * 1. Launched from Finder, an app inherits no shell environment, so
 *    `HTTPS_PROXY` is unset and SDK requests go out directly. Where Google is
 *    unreachable without a proxy that means `ETIMEDOUT`. Chromium knows the
 *    system proxy, so we ask it and publish the answer to the environment the
 *    Node SDKs read.
 *
 * 2. Electron's BoringSSL fails to decrypt the last TLS 1.3 record when the
 *    connection is tunnelled through some local proxies (reproduced with a
 *    CONNECT proxy on 127.0.0.1): the full response body arrives, then the
 *    socket raises `BAD_DECRYPT`, and the Google SDK reports the whole request
 *    as failed. System Node (OpenSSL) tolerates the same traffic. Capping the
 *    negotiated version at TLS 1.2 avoids that teardown path.
 *
 * Pure helpers live here so they can be tested without booting Electron.
 */

const tls = require('tls');

/**
 * Parse a Chromium PAC-style proxy resolution into a usable URL.
 *
 * `session.resolveProxy` answers with strings like `DIRECT`,
 * `PROXY 127.0.0.1:7890`, `PROXY a:1;PROXY b:2` or `SOCKS5 127.0.0.1:7890`.
 * Only HTTP(S) proxies are usable by the Node SDKs' proxy agents, so SOCKS
 * entries are ignored rather than mangled into an unusable http:// URL.
 *
 * @param {string} resolved - Value returned by session.resolveProxy
 * @returns {string|null} Proxy URL such as 'http://127.0.0.1:7890', or null
 */
function parseResolvedProxy(resolved) {
  if (!resolved || typeof resolved !== 'string') return null;

  for (const entry of resolved.split(';')) {
    const parts = entry.trim().split(/\s+/);
    if (parts.length < 2) continue; // DIRECT, or malformed
    const scheme = parts[0].toUpperCase();
    const target = parts[1];
    if (scheme !== 'PROXY' && scheme !== 'HTTPS') continue;
    if (!/^[^\s:]+:\d+$/.test(target)) continue;
    return `${scheme === 'HTTPS' ? 'https' : 'http'}://${target}`;
  }
  return null;
}

/**
 * Decide the proxy the Node SDKs should use.
 * An explicitly exported environment variable always wins over the system
 * setting, so launching from a terminal keeps working as before.
 *
 * @param {Object} env - Environment (process.env)
 * @param {string|null} systemProxy - Proxy URL detected from the system
 * @returns {Object} `{ proxyUrl, source }`
 */
function chooseProxy(env, systemProxy) {
  const fromEnv = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (fromEnv) return { proxyUrl: fromEnv, source: 'environment' };
  if (systemProxy) return { proxyUrl: systemProxy, source: 'system' };
  return { proxyUrl: null, source: 'none' };
}

/**
 * Apply the chosen proxy to the environment and cap TLS when tunnelling.
 *
 * @param {Object} options
 * @param {string|null} options.proxyUrl - Proxy URL, or null for direct
 * @param {Object} [options.env] - Environment to mutate (defaults to process.env)
 * @param {Object} [options.tlsModule] - tls module (injectable for tests)
 * @returns {Object} Summary of what was applied
 */
function applyNetworkConfig({ proxyUrl, env = process.env, tlsModule = tls }) {
  if (!proxyUrl) {
    return { proxy: null, tlsMaxVersion: tlsModule.DEFAULT_MAX_VERSION };
  }

  // Publish for the SDK proxy agents (gaxios / https-proxy-agent read these).
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!env[key]) env[key] = proxyUrl;
  }
  // Keep loopback and metadata endpoints off the proxy.
  if (!env.NO_PROXY && !env.no_proxy) {
    env.NO_PROXY = 'localhost,127.0.0.1,::1,metadata.google.internal';
    env.no_proxy = env.NO_PROXY;
  }

  // See note 2 in the file header.
  tlsModule.DEFAULT_MAX_VERSION = 'TLSv1.2';

  return { proxy: proxyUrl, tlsMaxVersion: tlsModule.DEFAULT_MAX_VERSION };
}

module.exports = { parseResolvedProxy, chooseProxy, applyNetworkConfig };
