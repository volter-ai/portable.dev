import http from 'http';
import { AddressInfo } from 'net';

import QRCode from 'qrcode';

/**
 * Loopback-only pairing fallback server.
 *
 * ⚠️ The pairing QR carries the data-path JWT, so the page that shows it MUST
 * NOT live on the api's TUNNELED port — `/t/<pcId>/api/pair` would be reachable
 * through the relay and LEAK the token. This server binds the launcher's OWN
 * loopback port (127.0.0.1, never tunneled), so only someone physically at the
 * PC can open it. It exists purely as a browser fallback for users whose
 * terminal can't render the Ink QR.
 *
 * It serves a tiny HTML page on `GET /` with the SAME QR (rendered to an inline
 * SVG via the `qrcode` lib) plus the pairing fields; everything else 404s. All
 * I/O is injectable so the lifecycle is unit-tested without a real socket.
 */

export interface PairingServerOptions {
  /** The QR payload string (`JSON.stringify({ gatewayBase, pcId, token })`). */
  payload: string;
  /** The per-PC relay endpoint shown on the page (informational). */
  endpoint: string;
  /** Preferred loopback port. 0 (default) lets the OS pick a free one. */
  port?: number;
  /** Loopback host. Defaults to 127.0.0.1 (NEVER 0.0.0.0 — must stay local). */
  host?: string;
  /**
   * SVG renderer seam (tests inject a stub). Defaults to `qrcode.toString` with
   * `type:'svg'`. Returns the inline `<svg>…</svg>` markup for the payload.
   */
  renderSvg?: (payload: string) => Promise<string>;
  /** http.createServer seam (tests inject a fake). Defaults to Node's http. */
  createServerImpl?: typeof http.createServer;
  /** Line sink. Defaults to console.log. */
  log?: (line: string) => void;
}

const LOOPBACK_HOST = '127.0.0.1';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Default SVG renderer — inline `<svg>` markup for the payload. */
export async function renderQrSvg(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: 'svg', margin: 1 });
}

/** Build the loopback pairing HTML page (exported for tests). */
export function buildPairingHtml(svg: string, endpoint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Portable — pair this PC</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background:#0d1117; color:#e6edf3;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    min-height:100vh; margin:0; padding:24px; box-sizing:border-box; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:24px;
    max-width:420px; text-align:center; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { color:#8b949e; font-size:13px; margin:4px 0 16px; }
  .qr { background:#fff; border-radius:8px; padding:12px; display:inline-block; }
  .qr svg { width:260px; height:260px; display:block; }
  code { color:#58a6ff; word-break:break-all; font-size:12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Pair this PC</h1>
    <p>Scan with the Portable app (Account &rarr; Connect a PC).</p>
    <div class="qr">${svg}</div>
    <p>Relay endpoint:<br /><code>${escapeHtml(endpoint)}</code></p>
  </div>
</body>
</html>`;
}

/**
 * Serves the loopback pairing page. {@link start} binds a free loopback port and
 * resolves with the `http://localhost:<port>/` URL; {@link stop} closes it.
 */
export class PairingServer {
  private readonly payload: string;
  private readonly endpoint: string;
  private readonly preferredPort: number;
  private readonly host: string;
  private readonly renderSvg: (payload: string) => Promise<string>;
  private readonly createServerImpl: typeof http.createServer;
  private readonly log: (line: string) => void;

  private server: http.Server | null = null;
  private url: string | null = null;

  constructor(options: PairingServerOptions) {
    this.payload = options.payload;
    this.endpoint = options.endpoint;
    this.preferredPort = options.port ?? 0;
    this.host = options.host ?? LOOPBACK_HOST;
    this.renderSvg = options.renderSvg ?? renderQrSvg;
    this.createServerImpl = options.createServerImpl ?? http.createServer;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** The bound `http://localhost:<port>/` URL, or null before {@link start}. */
  getUrl(): string | null {
    return this.url;
  }

  /** Bind the loopback port and start serving. Resolves with the local URL. */
  async start(): Promise<string> {
    if (this.url) return this.url;

    const svg = await this.renderSvg(this.payload);
    const html = buildPairingHtml(svg, this.endpoint);

    const server = this.createServerImpl((req, res) => {
      const method = (req.method ?? 'GET').toUpperCase();
      const path = (req.url ?? '/').split('?')[0];
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.preferredPort, this.host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? this.preferredPort;
    this.url = `http://localhost:${port}/`;
    this.log(
      `[pairing] loopback page → ${this.url} (open in a browser if the QR above won't render)`
    );
    return this.url;
  }

  /** Close the loopback server. Idempotent. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.url = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
