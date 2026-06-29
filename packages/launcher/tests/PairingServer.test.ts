/**
 * PairingServer tests.
 *
 * The loopback-only pairing fallback page MUST bind the launcher's own port
 * (127.0.0.1), NEVER the tunneled api port. The page shows the SAME QR as an
 * inline SVG. We drive a real loopback server (free port) and also assert the
 * built HTML embeds the SVG + endpoint.
 */
import { describe, expect, it } from 'bun:test';

import { PairingServer, buildPairingHtml } from '../src/PairingServer.js';

const PAYLOAD = JSON.stringify({
  gatewayBase: 'https://app.portable.dev',
  pcId: 'pc_loop',
  token: 'jwt-abc',
});
const ENDPOINT = 'https://app.portable.dev/t/pc_loop';

describe('buildPairingHtml', () => {
  it('embeds the SVG and the endpoint', () => {
    const html = buildPairingHtml('<svg id="qr"></svg>', ENDPOINT);
    expect(html).toContain('<svg id="qr"></svg>');
    expect(html).toContain('app.portable.dev/t/pc_loop');
    expect(html).toContain('Pair this PC');
  });
});

describe('PairingServer', () => {
  it('serves the QR page on / over loopback and 404s elsewhere', async () => {
    const server = new PairingServer({
      payload: PAYLOAD,
      endpoint: ENDPOINT,
      host: '127.0.0.1',
      renderSvg: async () => '<svg id="fake-qr"></svg>',
      log: () => {},
    });

    const url = await server.start();
    try {
      expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);

      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/html');
      const body = await ok.text();
      expect(body).toContain('<svg id="fake-qr"></svg>');
      expect(body).toContain('pc_loop');
      // The raw JWT must NOT be rendered in the page body (only encoded in the QR).
      expect(body).not.toContain('jwt-abc');

      const notFound = await fetch(`${url}nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('start() is idempotent and stop() is safe to call twice', async () => {
    const server = new PairingServer({
      payload: PAYLOAD,
      endpoint: ENDPOINT,
      renderSvg: async () => '<svg/>',
      log: () => {},
    });
    const url1 = await server.start();
    const url2 = await server.start();
    expect(url2).toBe(url1);
    await server.stop();
    await server.stop(); // no-op
    expect(server.getUrl()).toBeNull();
  });
});
