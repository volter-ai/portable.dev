/**
 * Connection types for external service integrations
 *
 * Supports two types of integrations:
 * - SDK: Services with JavaScript/TypeScript SDKs (Slack, Linear, Notion, etc.)
 * - CLI: Command-line tools (AWS CLI, kubectl, Docker, etc.)
 */

// ============================================================================
// CORE CONNECTION TYPES
// ============================================================================

/**
 * Service connection stored in database
 */
export interface ServiceConnection {
  id: string;
  userId: string;
  connectionId: string; // Machine-readable ID (e.g., 'modal_cli_1', 'slack_2') - lowercase alphanumeric + underscores only
  displayName: string; // User-friendly display name (e.g., 'My Modal CLI', 'Company Slack') - shown in UI
  service: string; // Service type: 'slack', 'linear', 'notion', 'aws', 'google-drive', etc.
  serviceType: 'sdk' | 'cli';
  credentials: any; // Service-specific credential structure
  connectedAt: Date;
  lastUsedAt?: Date;
  isActive: boolean; // Whether this connection is currently active (for exclusive services like AWS, Fly.io)
}

/**
 * Stored format (snake_case for the database)
 */
export interface StoredServiceConnection {
  id: string;
  user_id: string;
  connection_id: string; // Machine-readable ID
  display_name: string; // User-friendly display name
  service: string;
  service_type: 'sdk' | 'cli';
  credentials: any;
  connected_at: string;
  last_used_at?: string;
  is_active: boolean; // Whether this connection is currently active
}

// ============================================================================
// SERVICE CONFIGURATION TYPES
// ============================================================================

/**
 * Service category for filtering integrations
 */
export type ServiceCategory =
  | 'communication'
  | 'productivity'
  | 'development'
  | 'ai'
  | 'infrastructure'
  | 'storage';

/**
 * All available service categories with display labels
 */
export const SERVICE_CATEGORIES: Array<{ id: ServiceCategory | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'communication', label: 'Communication' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'development', label: 'Development' },
  { id: 'ai', label: 'AI & ML' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'storage', label: 'Storage' },
];

/**
 * Get service favicon using Google's Favicon V2 API or direct URL
 * @param domain - The domain to get favicon for (e.g., "slack.com") or a direct URL (e.g., "https://cdn.simpleicons.org/gmail")
 * @param size - Icon size in pixels (default: 64) - only used for Google Favicon API
 * @returns URL to the favicon image
 */
export function getServiceFavicon(domain: string, size: number = 64): string {
  // If domain is already a full URL (starts with http:// or https://), return it directly
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    return domain;
  }

  // Otherwise, use Google's Favicon V2 API
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}

/**
 * Form field configuration for manual credential input
 */
export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'textarea' | 'file' | 'file-or-textarea';
  placeholder?: string;
  required?: boolean;
  options?: string[] | { value: string; label: string }[]; // For select fields
  default?: string;
  accept?: string; // For file inputs (e.g., '.json', '.yaml')
  helpText?: string;
}

/**
 * OAuth configuration for services that use OAuth2
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret?: string; // Optional - handled by OAuth service, not exposed to sandbox
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri?: string; // Auto-generated if not provided
}

/**
 * Service configuration - defines how to connect to a service
 */
export interface ServiceConfig {
  name: string; // Display name (e.g., "Linear", "Slack")
  service: string; // Service identifier (e.g., "linear", "slack")
  type: 'sdk' | 'cli'; // SDK = multiple connections allowed, CLI = single connection only
  authType: 'oauth' | 'api-key' | 'config-file' | 'username-password' | 'service-account-json';
  icon: string; // Icon filename or URL (legacy, prefer domain for favicon)
  description: string; // Short description (one line)
  docs?: string; // Documentation URL
  fields?: FormField[]; // Form fields for manual credential input
  oauthConfig?: OAuthConfig; // OAuth configuration
  customAuthUrl?: string; // Custom auth URL (e.g., GitHub App installation page)
  enabled?: boolean; // Whether service is enabled (default: true)
  isExclusive?: boolean; // Whether only one connection can be active at a time (e.g., AWS, Fly.io set system credentials)

  // Rich metadata for connections page UI
  domain: string; // Domain for favicon lookup (e.g., "slack.com")
  category: ServiceCategory; // Category for filtering
  longDescription?: string; // Full description for detail view
  popular?: boolean; // For sorting/featuring popular services

  // Secret mapping - defines how credentials map to environment variable names
  // Key: credential field name, Value: environment variable name
  // Example: { token: 'GITHUB_TOKEN', accessKeyId: 'AWS_ACCESS_KEY_ID' }
  secretMapping?: Record<string, string>;
}

// ============================================================================
// DATABASE ADAPTER OPTIONS TYPES
// ============================================================================

/**
 * Base options for all connection operations
 * Contains common fields used across all methods
 */
export interface ConnectionBaseOptions {
  userId: string;
  /** JWT auth token */
  authToken?: string;
}

/**
 * Options for getUserConnections
 */
export interface GetUserConnectionsOptions extends ConnectionBaseOptions {}

/**
 * Options for getConnection, getConnectionCredentials, hasConnection, deleteConnection
 */
export interface GetConnectionOptions extends ConnectionBaseOptions {
  connectionId: string;
}

/**
 * Options for getConnectionsByService
 */
export interface GetConnectionsByServiceOptions extends ConnectionBaseOptions {
  service: string;
}

/**
 * Options for storeConnection
 */
export interface StoreConnectionOptions extends ConnectionBaseOptions {
  connectionId: string; // Machine-readable ID
  displayName: string; // User-friendly display name
  service: string;
  serviceType: 'sdk' | 'cli';
  credentials: any;
}

/**
 * Options for renameConnection (database layer)
 * Updates both displayName and connectionId
 */
export interface RenameConnectionDbOptions extends ConnectionBaseOptions {
  oldConnectionId: string; // Current connection ID
  newConnectionId: string; // New connection ID (derived from display name)
  newDisplayName: string; // New display name
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

/**
 * Request to connect a service
 */
export interface ConnectServiceRequest {
  connectionId: string; // User-defined connection ID
  service: string; // Service type
  credentials: any; // Service-specific credentials
}

/**
 * Response after connecting a service
 */
export interface ConnectServiceResponse {
  success: boolean;
  connection?: ServiceConnection;
  error?: string;
}

/**
 * Request to disconnect a service
 */
export interface DisconnectServiceRequest {
  connectionId: string; // Connection ID to disconnect
}

/**
 * Response after disconnecting a service
 */
export interface DisconnectServiceResponse {
  success: boolean;
  error?: string;
}

/**
 * Response listing all user connections
 */
export interface ListConnectionsResponse {
  connections: ServiceConnection[];
}

/**
 * Response for checking connection status
 */
export interface ConnectionStatusResponse {
  connected: boolean;
  connection?: ServiceConnection;
}

// ============================================================================
// CODE EXECUTOR TYPES
// ============================================================================

/**
 * Error thrown when required connections are missing
 */
export class MissingConnectionsError extends Error {
  constructor(
    message: string,
    public missingConnections: string[]
  ) {
    super(message);
    this.name = 'MissingConnectionsError';
  }
}

/**
 * Code executor input
 */
export interface CodeExecutorInput {
  connections: string[]; // Connection NAMES to use (e.g., ['company_slack', 'aws_prod'])
  code: string; // TypeScript code to execute
  description?: string; // Human-readable description
}

/**
 * Code executor result
 */
export interface CodeExecutorResult {
  success: boolean;
  result?: any;
  error?: {
    type: string;
    message: string;
    stack?: string;
    missingConnections?: string[]; // For MissingConnectionsError
  };
  connectionsUsed?: string[]; // Which connections were actually used
  description?: string;
}

// ============================================================================
// SERVICE-SPECIFIC CREDENTIAL TYPES
// ============================================================================

/**
 * Slack credentials (OAuth user token)
 * This is for user-level OAuth tokens (xoxp-...)
 * For bot tokens (xoxb-...), we'll create a separate 'slack-bot' service in the future
 */
export interface SlackCredentials {
  token: string; // OAuth user token (xoxp-...)
  teamId?: string;
  teamName?: string;
  userId?: string;
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * Slack Bot credentials (for future use)
 * Reserved for bot token integration
 */
export interface SlackBotCredentials {
  botToken: string; // Bot token (xoxb-...)
  teamId?: string;
  teamName?: string;
  botUserId?: string;
}

/**
 * Linear credentials (OAuth or API key)
 */
export interface LinearCredentials {
  token: string; // API key or OAuth access token
}

/**
 * Notion credentials (OAuth or internal integration)
 */
export interface NotionCredentials {
  token: string; // OAuth access token or internal integration token
}

/**
 * Google Drive credentials (OAuth)
 */
export interface GoogleDriveCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate?: number;
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * Gmail credentials (OAuth)
 */
export interface GmailCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate?: number;
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * AWS CLI credentials (API keys)
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * kubectl credentials (kubeconfig file)
 */
export interface KubectlCredentials {
  kubeconfig: string; // YAML content
}

/**
 * Docker credentials (username/password)
 */
export interface DockerCredentials {
  registry: string; // e.g., 'docker.io', 'ghcr.io'
  username: string;
  password: string; // Password or access token
}

/**
 * Google Cloud credentials (service account JSON)
 */
export interface GcloudCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

/**
 * Fly.io credentials (API token)
 */
export interface FlyioCredentials {
  apiToken: string; // Personal or organization access token
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * Modal credentials (API token ID and secret)
 */
export interface ModalCredentials {
  tokenId: string; // Token ID (starts with 'ak-')
  tokenSecret: string; // Token secret (starts with 'as-')
  profile?: string; // Optional profile name (defaults to 'default')
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * Apify credentials (API token)
 */
export interface ApifyCredentials {
  apiToken: string; // Apify API token (from Integrations page in Apify Console)
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string;
}

/**
 * GitHub App credentials (installation-based access)
 * Used for fine-grained repository permissions
 */
export interface GitHubAppCredentials {
  installationId: number; // GitHub App installation ID
  accountType: 'User' | 'Organization'; // Account type the app is installed on
  accountLogin: string; // Username or org name
  repositorySelection: 'all' | 'selected'; // Whether app has access to all or selected repos
  selectedRepositoryIds?: number[]; // IDs of selected repos (if repositorySelection is 'selected')
  permissions: Record<string, string>; // Granted permissions (e.g., { contents: 'read', issues: 'write' })
  // Cached installation access token (auto-refreshed)
  cachedToken?: string;
  cachedTokenExpiresAt?: string; // ISO 8601 timestamp
}

/**
 * Connection account information fetched from service APIs
 * Shows which account/identity is used for this connection
 * Stored in connection credentials for display
 */
export interface ConnectionAccountInfo {
  service: string;
  displayName?: string; // Account display name
  username?: string; // Username/login (e.g., GitHub login)
  email?: string; // Email address
  accountId?: string; // Service-specific account ID
  avatarUrl?: string; // Profile picture URL
  metadata?: Record<string, any>; // Service-specific extra data
}

/**
 * Enhanced credentials with account info
 * Mix this into credential types to add account info caching
 */
export interface CredentialsWithAccountInfo {
  accountInfo?: ConnectionAccountInfo;
  lastAccountInfoFetch?: string; // ISO timestamp of last fetch
}

// ============================================================================
// VALIDATION AND HELPER FUNCTIONS
// ============================================================================

/**
 * Validation result for connection names
 */
export interface ConnectionNameValidation {
  valid: boolean;
  error?: string;
}

/**
 * Derive a valid connection ID using numbered format
 *
 * The display name is for human readability only.
 * The ID uses the service name, adding sequential numbers only if there's a collision.
 *
 * @param displayName - Human-readable name (not used in ID generation)
 * @param service - Service ID (e.g., "flyio-cli")
 * @param existingNames - Array of existing connection IDs to avoid collisions
 * @returns Valid connection ID (e.g., "flyio_cli_1" or "flyio_cli_2")
 *
 * @example
 * deriveConnectionId('Fly.io CLI', 'flyio-cli', []) // 'flyio_cli_1' (avoids service ID collision)
 * deriveConnectionId('My Slack', 'slack', []) // 'slack_1' (avoids service ID collision)
 * deriveConnectionId('My Slack', 'slack', ['slack_1']) // 'slack_2'
 */
export function deriveConnectionId(
  displayName: string, // Unused - kept for API compatibility, display name is separate from ID
  service: string,
  existingNames: string[] = []
): string {
  // Sanitize service ID (replace hyphens with underscores)
  const servicePrefix = service.replace(/-/g, '_');

  // Always start with _1 to avoid collision with the service ID itself
  // (e.g., service "flyio-cli" becomes "flyio_cli", so we use "flyio_cli_1")
  let counter = 1;
  let connectionId = `${servicePrefix}_${counter}`;

  // Find the next available number if there are collisions
  while (existingNames.includes(connectionId)) {
    counter++;
    connectionId = `${servicePrefix}_${counter}`;
  }

  return connectionId;
}

/**
 * Validate a connection ID according to naming rules
 * (IDs are auto-generated, but this validates them)
 *
 * Rules:
 * - Must be 1-50 characters long
 * - Must contain only lowercase letters, numbers, and underscores
 * - Must match pattern: ^[a-z0-9_]+$
 *
 * @param name - Connection ID to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * validateConnectionName('company_slack') // { valid: true }
 * validateConnectionName('Company-Slack') // { valid: false, error: '...' }
 */
export function validateConnectionName(name: string): ConnectionNameValidation {
  if (!name || name.length === 0) {
    return { valid: false, error: 'Connection name is required' };
  }

  if (name.length > 50) {
    return { valid: false, error: 'Connection name too long (max 50 characters)' };
  }

  if (!/^[a-z0-9_]+$/.test(name)) {
    return {
      valid: false,
      error: 'Connection name must contain only lowercase letters, numbers, and underscores',
    };
  }

  return { valid: true };
}

/**
 * Generate a default connection name for a service
 *
 * @param service - Service type (e.g., 'slack', 'aws', 'flyio-cli')
 * @returns Default connection name (e.g., 'slack_1', 'flyio_cli_1')
 *
 * @example
 * getDefaultConnectionName('slack') // 'slack_1'
 * getDefaultConnectionName('flyio-cli') // 'flyio_cli_1'
 */
export function getDefaultConnectionName(service: string): string {
  // Replace hyphens with underscores to comply with validation rules
  // Use _1 suffix to avoid collision with service ID (e.g., flyio_cli_1 != flyio_cli)
  const sanitized = service.replace(/-/g, '_');
  return `${sanitized}_1`;
}

/**
 * Generate a numbered connection name suggestion
 *
 * @param service - Service type
 * @param number - Connection number (e.g., 2, 3, 4)
 * @returns Numbered connection name (e.g., 'slack_2', 'flyio_cli_2')
 *
 * @example
 * getNumberedConnectionName('slack', 2) // 'slack_2'
 * getNumberedConnectionName('flyio-cli', 3) // 'flyio_cli_3'
 */
export function getNumberedConnectionName(service: string, number: number): string {
  // Replace hyphens with underscores to comply with validation rules
  const sanitized = service.replace(/-/g, '_');
  return `${sanitized}_${number}`;
}

/**
 * Generate connection name suggestions based on existing connections
 *
 * @param service - Service type
 * @param existingNames - Array of existing connection names
 * @returns Array of suggested connection names
 *
 * @example
 * suggestConnectionNames('slack', ['slack_1'])
 * // Returns: ['slack_2', 'slack_prod', 'slack_dev', 'slack_personal', 'slack_work']
 * suggestConnectionNames('flyio-cli', [])
 * // Returns: ['flyio_cli_1']
 */
export function suggestConnectionNames(service: string, existingNames: string[]): string[] {
  // Replace hyphens with underscores to comply with validation rules
  const sanitized = service.replace(/-/g, '_');
  const suggestions: string[] = [];

  // If no connections exist, suggest default
  if (existingNames.length === 0) {
    return [getDefaultConnectionName(service)];
  }

  // Find next available number
  let nextNumber = 2;
  while (existingNames.includes(getNumberedConnectionName(service, nextNumber))) {
    nextNumber++;
  }
  suggestions.push(getNumberedConnectionName(service, nextNumber));

  // Add common suffixes if not already taken
  const commonSuffixes = ['prod', 'dev', 'staging', 'personal', 'work', 'test'];
  for (const suffix of commonSuffixes) {
    const name = `${sanitized}_${suffix}`;
    if (!existingNames.includes(name)) {
      suggestions.push(name);
      if (suggestions.length >= 5) break; // Limit to 5 suggestions
    }
  }

  return suggestions;
}

// ============================================================================
// RENAME REQUEST/RESPONSE TYPES
// ============================================================================

/**
 * Request to rename a connection
 */
export interface RenameConnectionRequest {
  connectionId: string; // Current connection ID
  newName: string; // New connection ID
}

/**
 * Response after renaming a connection
 */
export interface RenameConnectionResponse {
  success: boolean;
  connection?: ServiceConnection;
  error?: string;
}
