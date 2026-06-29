/**
 * Ambient module shim for `bun:sqlite`.
 *
 * The prod server runs Bun (`bun src/server.ts`), so `bun:sqlite` is a
 * real runtime module — but the repo intentionally does NOT depend on
 * `@types/bun` / `bun-types` (adding it globally breaks the `db.query<T>` API
 * surface and conflicts the `fetch` global with `@types/node` — see the Ralph
 * progress log). This narrow, hand-written declaration covers exactly the slice
 * of the `bun:sqlite` API the local SQLite stores use (SqliteChatStore,
 * SqliteConnectionStore), so `tsc` resolves the import and types the prepared
 * statement rows instead of silently degrading the whole file to `any`.
 *
 * Keep it minimal: extend it only when a store starts using more of the API.
 */
declare module 'bun:sqlite' {
  /** A prepared statement parameterized by its row shape `T`. */
  export class Statement<T = unknown> {
    /** Execute and return all rows. */
    all(...params: unknown[]): T[];
    /** Execute and return the first row, or `undefined` when there are none. */
    get(...params: unknown[]): T | undefined;
    /** Execute a write; the result shape is not used by our stores. */
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    /** Release the underlying statement handle. */
    finalize(): void;
  }

  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions);
    /** Prepare a statement; the type argument is the row shape returned by `get`/`all`. */
    prepare<T = unknown>(sql: string): Statement<T>;
    /** Execute one or more statements with no parameters. */
    exec(sql: string): void;
    /** Run a statement directly (no prepared-statement reuse). */
    run(sql: string, ...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
    /** Wrap `fn` in a transaction; the returned function commits/rolls back on call. */
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
    /** Close the database handle. */
    close(): void;
  }

  export default Database;
}
