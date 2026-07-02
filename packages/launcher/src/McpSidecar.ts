/**
 * `portable mcp-sidecar` — the zero-tool MCP sidecar (rev12, PRD D58).
 *
 * Registered USER-SCOPE in Claude Code's MCP config by the launcher, so every
 * terminal `claude` session on this PC spawns one instance as ITS OWN CHILD.
 * That parentage is the point: the sidecar knows the CLI's pid
 * (`process.ppid`) trustworthily, and holds a persistent loopback channel to
 * the Portable api — the delivery path for Stop-on-PC (MCP itself has no
 * "interrupt host" primitive; the stop is an OS signal to the parent, this
 * channel just delivers the command to the right process).
 *
 * Two halves, both fail-silent:
 * 1. **MCP stdio protocol** (newline-delimited JSON-RPC on stdin/stdout):
 *    `initialize` → capabilities with ZERO tools (the model never sees us),
 *    `tools/list` → `[]`, `ping` → `{}`. stdout carries ONLY protocol frames.
 *    Exit when stdin ends (the parent CLI died).
 * 2. **Channel loop**: read `internal-bridge.json` (re-read every cycle —
 *    Portable may start AFTER this claude session), register `{ppid, cwd}`,
 *    then long-poll for commands. `stop {mode}` → signal the parent CLI
 *    (SIGINT = interrupt, SIGTERM = end). Portable off ⇒ idle with backoff.
 */
import readline from 'readline';

import { INTERNAL_SECRET_HEADER } from './HookRelay.js';
import { readBridgeFromFile, readInternalBridge, type InternalBridge } from './InternalBridge.js';

/** The MCP protocol version we answer with when the client's is unknown. */
const FALLBACK_PROTOCOL_VERSION = '2024-11-05';

/** One parsed JSON-RPC message (loose). */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Answer one MCP client message. Returns the JSON-RPC response object to write
 * (one line), or null for notifications / unanswerable input. Pure — the
 * transport loop owns I/O. Exported for tests.
 */
export function handleMcpMessage(msg: JsonRpcMessage): Record<string, unknown> | null {
  if (!msg || typeof msg.method !== 'string') return null;
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!isRequest) return null; // notifications (initialized, cancelled, …) need no reply

  switch (msg.method) {
    case 'initialize': {
      const requested = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion:
            typeof requested === 'string' && requested.length > 0
              ? requested
              : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'portable-sidecar', version: '1.0.0' },
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: [] } };
    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

/** A command delivered over the sidecar channel (today: only stop). */
export interface SidecarCommand {
  command: 'stop';
  /** `interrupt` (SIGINT, ≈ Ctrl+C) or `end` (SIGTERM). */
  mode: 'interrupt' | 'end';
}

export interface SidecarChannelDeps {
  ppid: number;
  cwd: string;
  readBridge: () => InternalBridge | null;
  fetchImpl: typeof fetch;
  /** Deliver a signal to the parent CLI. Injected for tests. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  log: (line: string) => void; // stderr only — stdout belongs to MCP
  /**
   * Aborted when the parent CLI closes stdin (N5). Combined with each request's
   * own timeout so an in-flight long-poll is cancelled immediately on shutdown
   * — otherwise its open socket keeps the event loop alive and an orphaned
   * sidecar lingers up to ~35s after the parent dies.
   */
  shutdownSignal?: AbortSignal;
}

/**
 * One channel cycle: register (idempotent server-side) then long-poll once.
 * Returns what happened so the loop can pick its next delay. Never throws.
 */
export async function runChannelCycle(
  deps: SidecarChannelDeps
): Promise<'no-bridge' | 'error' | 'idle' | 'stopped'> {
  const bridge = deps.readBridge();
  if (!bridge) return 'no-bridge';
  const base = `http://127.0.0.1:${bridge.port}/api/internal/sidecar`;
  const headers = { [INTERNAL_SECRET_HEADER]: bridge.secret, 'content-type': 'application/json' };
  // AbortController + setTimeout (not AbortSignal.timeout) — mirrors HookRelay;
  // the launcher lint env doesn't know the AbortSignal global. The controller
  // also aborts when the shutdown signal fires (stdin close), so an in-flight
  // long-poll is cancelled on parent death (N5).
  const abortAfter = (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    (timer as { unref?: () => void }).unref?.();
    const shutdown = deps.shutdownSignal;
    if (shutdown) {
      if (shutdown.aborted) controller.abort();
      else shutdown.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return controller.signal;
  };

  try {
    const reg = await deps.fetchImpl(`${base}/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ppid: deps.ppid, cwd: deps.cwd }),
      signal: abortAfter(5_000),
    });
    if (!reg.ok) return 'error';

    // Long-poll for a command. The server parks the request up to waitMs;
    // 204 = nothing this window. The client timeout leaves slack over waitMs.
    const poll = await deps.fetchImpl(`${base}/poll?pid=${deps.ppid}&waitMs=25000`, {
      headers,
      signal: abortAfter(35_000),
    });
    if (poll.status === 204) return 'idle';
    if (!poll.ok) return 'error';

    const body = (await poll.json()) as Partial<SidecarCommand> | undefined;
    if (body?.command === 'stop') {
      const signal: NodeJS.Signals = body.mode === 'end' ? 'SIGTERM' : 'SIGINT';
      deps.log(`[sidecar] stop(${body.mode ?? 'interrupt'}) → ${signal} to ${deps.ppid}`);
      try {
        deps.kill(deps.ppid, signal);
      } catch {
        // Parent already gone — the transport loop will exit on stdin end.
      }
      return 'stopped';
    }
    return 'idle';
  } catch {
    return 'error';
  }
}

export interface RunMcpSidecarOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Absolute path to `internal-bridge.json`, embedded by the launcher into the
   * sidecar's user-scope MCP args (`mcp-sidecar --bridge <path>`) so it reads
   * THAT file rather than re-resolving DATA_DIR from a project env (B2).
   */
  bridgePath?: string;
  readBridge?: () => InternalBridge | null;
  fetchImpl?: typeof fetch;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  ppid?: number;
  cwd?: string;
  /** Sleep seam (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run the sidecar until the parent CLI closes stdin. Resolves on shutdown.
 * stdout is written EXCLUSIVELY with newline-delimited JSON-RPC frames.
 */
export async function runMcpSidecar(options: RunMcpSidecarOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  // Default sleep timers are UNREF'd (N5) so a parked backoff never keeps the
  // event loop alive after stdin closes.
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        (t as { unref?: () => void }).unref?.();
      }));

  // Aborted on stdin close so the in-flight long-poll is cancelled immediately.
  const shutdown = new AbortController();

  const deps: SidecarChannelDeps = {
    ppid: options.ppid ?? process.ppid,
    cwd: options.cwd ?? process.cwd(),
    readBridge:
      options.readBridge ??
      (() => (options.bridgePath ? readBridgeFromFile(options.bridgePath) : readInternalBridge())),
    fetchImpl: options.fetchImpl ?? fetch,
    kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
    log: (line) => process.stderr.write(`${line}\n`),
    shutdownSignal: shutdown.signal,
  };

  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input });
    rl.on('line', (line) => {
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return; // not a frame — ignore
      }
      const response = handleMcpMessage(parsed);
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    rl.on('close', () => {
      closed = true;
      shutdown.abort(); // cancel any in-flight long-poll (N5)
      resolve();
    });
  });

  // Channel loop, concurrent with the protocol reader. Delay policy: Portable
  // off → re-check the bridge every 30s; transient error → 10s backoff;
  // idle/served → immediately poll again (the long-poll IS the wait).
  const channelLoop = (async () => {
    while (!closed) {
      const outcome = await runChannelCycle(deps);
      if (closed) break;
      if (outcome === 'no-bridge') await sleep(30_000);
      else if (outcome === 'error') await sleep(10_000);
      else if (outcome === 'stopped') await sleep(1_000);
    }
  })();

  await closedPromise;
  await Promise.race([channelLoop, sleep(50)]);
}
