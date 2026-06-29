/**
 * SqliteDbAdapter module exports
 *
 * SQLite-backed chat/message persistence, replacing the JSON
 * file storage of JsonDbAdapter, plus the connections domain,
 * the themes domain, the push-subscriptions domain, and
 * the service-accounts + audit-log domain on local SQLite. Every
 * domain is local — there is no wrapped adapter. Legacy JSON chat data is
 * migrated into SQLite automatically on initialize (once, non-destructively).
 */

export { SqliteDbAdapter } from './SqliteDbAdapter.js';
export { SqliteChatStore, SQLITE_DB_FILE } from './SqliteChatStore.js';
export { SqliteConnectionStore, SQLITE_CONNECTIONS_DB_FILE } from './SqliteConnectionStore.js';
export { SqliteThemeStore, SQLITE_THEMES_DB_FILE } from './SqliteThemeStore.js';
export { SqlitePushStore, SQLITE_PUSH_DB_FILE } from './SqlitePushStore.js';
export {
  SqliteServiceAccountStore,
  SQLITE_SERVICE_ACCOUNTS_DB_FILE,
} from './SqliteServiceAccountStore.js';
export {
  SqliteSecretsVaultStore,
  SQLITE_SECRETS_VAULT_DB_FILE,
} from './SqliteSecretsVaultStore.js';
export {
  migrateJsonToSqlite,
  SQLITE_MIGRATION_MARKER,
  type MigrationResult,
} from './JsonToSqliteMigrator.js';
