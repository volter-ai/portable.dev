/**
 * Chats client + live watcher for the connected menu's chats column.
 *
 * The chat list is request-scoped (it belongs to the authenticated user), so the
 * launcher reads it from the api over loopback using the SAME data-path JWT it
 * minted — `req.session.userEmail` is populated from the Bearer payload, so
 * `GET /api/chats` works directly. This reuses the api's existing chat discovery
 * (titles, repo, recency, transcript+SQLite union) so the list matches the app.
 *
 * `archive()` hits the thin `POST /api/chats/:id/archive` route (reversible — it
 * does NOT delete the shared ~/.claude/projects transcript).
 */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** A chat row shaped for the terminal list. */
export interface ChatSummary {
  id: string;
  title: string;
  repoFullName?: string;
  preview?: string;
  lastUpdated?: string;
}

export interface ChatsClientOptions {
  apiBaseUrl: string;
  /** The data-path JWT the launcher minted (Bearer). */
  token: string;
  fetchImpl?: FetchImpl;
}

/** Normalize a chat timestamp (epoch ms/seconds number OR ISO string) → ISO string. */
function normalizeTimestamp(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // Heuristic: < 1e12 looks like epoch SECONDS; otherwise epoch MS.
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return undefined;
}

export class ChatsClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(options: ChatsClientOptions) {
    this.base = options.apiBaseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** The most-recently-active, non-archived PORTABLE chats (newest first). */
  async listRecent(limit = 30): Promise<ChatSummary[]> {
    // `source=portable`: only chats opened + messaged in Portable (not imported
    // ~/.claude/projects transcripts). `previews=false`: skip the per-chat transcript
    // reads (the terminal shows title/repo/time only) — much faster. Both are
    // terminal-only; the mobile app omits them.
    const url = `${this.base}/api/chats?archived=false&source=portable&previews=false&limit=${limit}`;
    const res = await this.fetchImpl(url, { method: 'GET', headers: this.authHeaders() });
    if (!res.ok) throw new Error(`GET /api/chats → HTTP ${res.status}`);
    const body = (await res.json()) as { chats?: unknown };
    const rows = Array.isArray(body?.chats) ? (body.chats as Record<string, unknown>[]) : [];
    return rows
      .map((c) => ({
        id: String(c.id),
        title:
          (typeof c.title === 'string' && c.title.trim()) ||
          (typeof c.firstMessagePreview === 'string' && c.firstMessagePreview.trim()) ||
          'Untitled chat',
        repoFullName: typeof c.repoFullName === 'string' ? c.repoFullName : undefined,
        preview:
          (typeof c.lastMessagePreview === 'string' && c.lastMessagePreview) ||
          (typeof c.firstMessagePreview === 'string' && c.firstMessagePreview) ||
          undefined,
        // `lastUpdated`/`last_updated` arrives as epoch MS (a number) for SQLite +
        // transcript-discovered chats — normalize to an ISO string for the UI.
        lastUpdated: normalizeTimestamp(c.lastUpdated ?? c.last_updated),
      }))
      .sort(
        (a, b) => (Date.parse(b.lastUpdated ?? '') || 0) - (Date.parse(a.lastUpdated ?? '') || 0)
      );
  }

  /** Archive (or unarchive) a chat — reversible; never touches the transcript. */
  async archive(chatId: string, archived = true): Promise<void> {
    const url = `${this.base}/api/chats/${encodeURIComponent(chatId)}/archive`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) throw new Error(`POST /api/chats/:id/archive → HTTP ${res.status}`);
  }
}

export interface ChatsWatcherHandle {
  /** Force an immediate refresh (e.g. right after archiving). */
  refresh(): void;
  /** Stop polling. Idempotent. */
  stop(): void;
}

export interface StartChatsWatchOptions {
  intervalMs?: number;
  setIntervalImpl?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

/** A stable signature for a chat list, to detect changes between polls. */
function signature(chats: ChatSummary[]): string {
  return chats.map((c) => `${c.id}:${c.title}:${c.lastUpdated ?? ''}`).join('|');
}

/**
 * Poll the chat list. Calls {@link onChats} immediately and again whenever the list
 * changes. `load` is the async fetch (injected for tests); a slow/failed load never
 * overlaps or throws. Returns a handle with `refresh()` (force a poll now) + `stop()`.
 */
export function startChatsWatch(
  load: () => Promise<ChatSummary[]>,
  onChats: (chats: ChatSummary[]) => void,
  options: StartChatsWatchOptions = {}
): ChatsWatcherHandle {
  const intervalMs = options.intervalMs ?? 3000;
  const setI = options.setIntervalImpl ?? setInterval;
  const clearI = options.clearIntervalImpl ?? clearInterval;

  let last: string | null = null;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    if (inFlight) return;
    inFlight = true;
    load()
      .then((chats) => {
        const sig = signature(chats);
        if (sig !== last) {
          last = sig;
          onChats(chats);
        }
      })
      .catch(() => {
        // transient (api not ready / fetch error) → try again next tick
      })
      .finally(() => {
        inFlight = false;
      });
  };

  poll(); // initial load
  timer = setI(poll, intervalMs);
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    refresh: () => poll(),
    stop: () => {
      if (timer !== null) {
        try {
          clearI(timer);
        } catch {
          // ignore
        }
        timer = null;
      }
    },
  };
}
