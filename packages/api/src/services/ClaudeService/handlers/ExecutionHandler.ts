import { execSync } from 'child_process';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ANTHROPIC_API_KEY } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { createAskUserMcpServer } from '../../../mcp/AskUserMcpServer.js';
import { loudError } from '../../../utils/loudError.js';
import { MessageQueue, createMessageGenerator } from '../../../utils/MessageQueue.js';
import { syncPortableCoAuthorHook } from '../coAuthorHook.js';
import { resolveIncludeCoAuthoredBy } from '../coAuthorPreference.js';
import {
  chooseGitIdentityToWrite,
  resolveGitAuthorIdentity,
  type ExistingGitIdentity,
} from '../gitAuthorIdentity.js';
import { slashCommandRegistry } from '../slashCommandRegistry.js';

import type { ToolExecutionContext } from '../../../tools/types.js';
import type { IOutputEmitter } from '../../emitters/IOutputEmitter.js';
import type { HandlerDependencies, ApiRoutingMode } from '../types.js';
import type { SDKUserMessage, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';

/**
 * Read a repo's EFFECTIVE git identity — its local `git config user.*` override OR
 * its inherited global — by running `git config user.name|user.email` in the repo.
 * Returns null when either is unset/blank (git exits non-zero) or anything throws.
 * Used to AVOID overwriting the repo owner's identity with the fallback (PC hostname).
 */
function readExistingGitIdentity(repoPath: string): ExistingGitIdentity | null {
  try {
    const name = execSync('git config user.name', { cwd: repoPath }).toString().trim();
    const email = execSync('git config user.email', { cwd: repoPath }).toString().trim();
    return name && email ? { name, email } : null;
  } catch {
    return null; // unset (exit 1) or unreadable → treat as "no existing identity"
  }
}

/**
 * ExecutionHandler - Core orchestration for Claude Code sessions
 *
 * This handler contains ALL execution logic (~1500 lines ported from original ClaudeService)
 * Responsibilities:
 * - Route session start requests (injection vs creation/resumption)
 * - Execute complete Claude Code sessions
 * - Determine API routing mode (always direct)
 * - Coordinate all other handlers for session execution
 * - Manage session lifecycle from start to completion
 */
export class ExecutionHandler {
  // Dependencies from other handlers
  private sessionHandler: any;
  private streamHandler: any;
  private agentHandler: any;
  private actionHandler: any;

  // Service dependencies
  private chatService: any;
  private mcpService: any;
  private mediaProcessingService: any;
  private gitLocalService?: any;
  private tunnelService?: any;
  private secretsService?: any;
  private connectionsService?: any;
  private chatExecutionService?: any;
  // Local-first AI credentials: Claude OAuth / ANTHROPIC_API_KEY,
  // resolved locally — never from a JWT claim. Injected via setter in local mode.
  private localAiCredentialsService?: import('../../LocalAiCredentialsService.js').LocalAiCredentialsService;

  // State
  private claudeCodeSessions: Map<string, any>;
  private postCompressionFlags: Map<string, boolean>;
  private activeSubAgents: Map<string, any>;
  private permissionRequests: Map<string, any>;
  private pendingPermissions: Map<string, string>;
  private askUserMcpServer?: any;

  constructor(
    dependencies: HandlerDependencies,
    handlers: {
      sessionHandler: any;
      streamHandler: any;
      permissionHandler: any;
      agentHandler: any;
      actionHandler: any;
    },
    claudeCodeSessions: Map<string, any>,
    permissionRequests: Map<string, any>,
    pendingPermissions: Map<string, string>
  ) {
    this.sessionHandler = handlers.sessionHandler;
    this.streamHandler = handlers.streamHandler;
    this.agentHandler = handlers.agentHandler;
    this.actionHandler = handlers.actionHandler;

    this.chatService = dependencies.chatService;
    this.mcpService = dependencies.mcpService;
    this.mediaProcessingService = dependencies.mediaProcessingService;
    this.gitLocalService = dependencies.gitLocalService;
    this.tunnelService = dependencies.tunnelService;
    this.secretsService = dependencies.secretsService;
    this.connectionsService = dependencies.connectionsService;
    this.chatExecutionService = dependencies.chatExecutionService;
    this.localAiCredentialsService = dependencies.localAiCredentialsService;

    this.claudeCodeSessions = claudeCodeSessions;
    this.permissionRequests = permissionRequests;
    this.pendingPermissions = pendingPermissions;
    this.postCompressionFlags = new Map();
    this.activeSubAgents = new Map();
  }

  /**
   * Inject the local-first AI credentials service. Called after
   * construction in local mode so the device/PC's own Claude OAuth or
   * ANTHROPIC_API_KEY drives AI calls (never a JWT claim).
   */
  setLocalAiCredentialsService(
    service: import('../../LocalAiCredentialsService.js').LocalAiCredentialsService
  ): void {
    this.localAiCredentialsService = service;
  }

  /**
   * Determines the API routing mode for Anthropic API calls.
   * Local-first: always 'direct'. AI calls use the user's OWN credential
   * (LocalAiCredentialsService).
   *
   * @param userId - User ID for logging
   * @returns 'direct'
   */
  determineApiRoutingMode(userId: string): ApiRoutingMode {
    console.log(`[ExecutionHandler] [${userId}] 🏠 Direct Anthropic API (local credentials)`);
    return 'direct';
  }

  async startClaudeCodeSession(params: {
    ws: WebSocket;
    chatId: string;
    repoPath: string;
    task: string;
    uploadedFiles?: any[]; // Uploaded files for image attachments
    systemPrompt: string;
    userId: string;
    username: string; // REQUIRED: GitHub username for git commits (prevents "Claude" attribution)
    owner?: string; // GitHub owner
    repo?: string; // GitHub repo
    playwrightDevice?: 'mobile' | 'desktop'; // Device mode for browser automation
    model?: string; // Model to use (sonnet or haiku)
    permissions?: string; // Permissions mode (default, automatic, ask)
    authToken?: string; // JWT token for authentication and token extraction
    sessionGitHubToken?: string; // GitHub OAuth token from session (for dev mode OAuth login) [DEPRECATED - unused]
    agentSetupId?: string; // Agent setup configuration
    forkFromSessionId?: string; // Fork-on-first-write: original CC session id to fork from
    emitter?: IOutputEmitter; // Optional: output emitter for real-time notifications (portable_execute)
  }): Promise<void> {
    const {
      ws,
      chatId,
      task,
      uploadedFiles = [],
      userId,
      model,
      permissions,
      authToken,
      // sessionGitHubToken, // No longer used - GitHub auth resolved via ConnectionsService
      agentSetupId = 'freestyle', // Default to freestyle if not specified
    } = params;

    // Check if we have an existing persistent session
    const existingSession = this.claudeCodeSessions.get(chatId);

    // Check if session parameters changed (permissions or model)
    // If changed, stop session to force recreation with new parameters
    if (existingSession && existingSession.query && existingSession.inputQueue) {
      const permissionsChanged = existingSession.permissions !== permissions;
      const modelChanged = existingSession.model !== model;

      if (permissionsChanged || modelChanged) {
        console.log(
          `[ClaudeService] [${userId}] Session params changed for ${chatId} — stopping to recreate`
        );
        await this.sessionHandler.stopSession(chatId, userId);
      }
    }

    // CASE 1: Session has active query AND inputQueue → INJECT message
    // With unified cleanup in finally, when subprocess dies the for-await loop exits,
    // cleanup sets query=null and inputQueue=undefined, so this condition won't match.
    if (existingSession && existingSession.query && existingSession.inputQueue) {
      console.log(
        `[ClaudeService] [${userId}] CASE 1: INJECT into active session ${chatId} (session_id=${existingSession.session_id})`
      );

      const messageContent = this.mediaProcessingService.formatMessageWithFiles(
        task,
        uploadedFiles
      );

      const userMessage: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: messageContent },
        session_id: existingSession.session_id || chatId,
        parent_tool_use_id: null,
      };

      existingSession.inputQueue.enqueue(userMessage);
      existingSession.isProcessing = true;
      existingSession.lastActivityAt = Date.now(); // idle-reaper activity tracking

      ws.send(
        JSON.stringify({
          type: 'chat_status_update',
          chat_id: chatId,
          status: 'running',
        })
      );

      // Live session went idle → running: refresh the runtime panel.
      this.emitRuntimeStateRefresh(ws, chatId);

      return; // Done — message injected, iterator will process it
    }

    // CASE 2 & 3: Need to create or resume session
    console.log(
      `[ClaudeService] [${userId}] CASE 2/3: ${existingSession?.session_id ? 'RESUME' : 'CREATE'} session for ${chatId}`
    );

    // Send status update to the client - session is starting/resuming
    ws.send(
      JSON.stringify({
        type: 'chat_status_update',
        chat_id: chatId,
        status: 'running',
      })
    );

    return this.executeClaudeCodeSession({
      ...params,
      agentSetupId,
    });
  }

  private async executeClaudeCodeSession(params: {
    ws: WebSocket;
    chatId: string;
    repoPath: string;
    task: string;
    uploadedFiles?: any[]; // Uploaded files for image attachments
    systemPrompt: string;
    userId: string;
    username: string; // REQUIRED: GitHub username for git commits (prevents "Claude" attribution)
    playwrightDevice?: 'mobile' | 'desktop';
    model?: string;
    permissions?: string;
    authToken?: string; // JWT token for authentication and token extraction
    sessionGitHubToken?: string; // Session GitHub token for development OAuth [DEPRECATED - unused]
    agentSetupId?: string; // Agent setup configuration
    forkFromSessionId?: string; // Fork-on-first-write: original CC session id to fork from
    emitter?: IOutputEmitter; // Optional: output emitter for portable_execute
  }): Promise<void> {
    const {
      ws,
      chatId,
      repoPath,
      task,
      uploadedFiles = [],
      systemPrompt,
      userId,
      username,
      playwrightDevice = 'mobile',
      model,
      permissions,
      authToken,
      // sessionGitHubToken, // No longer used - GitHub auth resolved via ConnectionsService
      agentSetupId = 'freestyle',
      forkFromSessionId,
      emitter, // Optional: output emitter for portable_execute
    } = params;

    // User connection tokens (Google Drive, Slack, etc.) are managed by ConnectionsService

    // Get existing session for resume check
    const existingSession = this.claudeCodeSessions.get(chatId);

    // Declared at function scope so `finally` block can access for cleanup
    let tunnelMappings: Array<{ port: number; url: string }> = [];

    // Verify repository exists in workspace
    try {
      const repoStat = await fs.stat(repoPath);
      if (!repoStat.isDirectory()) {
        console.warn(`[ClaudeService] [${userId}] Path is not a directory: ${repoPath}`);
      }
    } catch {
      console.warn(
        `[ClaudeService] [${userId}] Repo not found at ${repoPath} — using workspace root`
      );
    }

    // The PC-minted JWT (validated locally) is the per-request credential.
    if (!authToken) {
      throw new Error(
        'No authToken provided. ' +
          'JWT is required in all environments as the per-request credential.'
      );
    }

    // Create tool execution context for unified tools
    const toolContext: ToolExecutionContext = {
      userId,
      ws,
      chatId,
      repoPath,
      gitLocalService: this.gitLocalService,
      tunnelService: this.tunnelService,
      chatService: this.chatService, // For chat management tools
      chatExecutionService: this.chatExecutionService, // For triggering execution of new chats (create_chat tool)
      secretsService: this.secretsService, // For portable_execute SDK
      connectionsService: this.connectionsService, // For portable_execute SDK
      emitter, // For portable_execute SDK (real-time notifications)
      model,
      permissions,
      authToken, // Raw per-request JWT (single source of truth for tokens)
      emitEvent: (_event: string, data: any) => {
        // GitHub tools call: context.emitEvent("navigate", navMessage)
        // navMessage already has type: "navigate", so just send it
        // The mock WebSocket in SocketIOService will handle it
        ws.send(JSON.stringify(data));
      },
    };

    // Create message queue and signal for the generator
    const messageQueue: Array<{ content: string }> = []; // Legacy - kept for compatibility
    const signal = { stopped: false };

    let sessionError: any = null;

    try {
      // FORK-ON-FIRST-WRITE: this chat was claimed from a Claude Code terminal transcript
      // (no prior Portable session). Fork from the ORIGINAL session id so the SDK reads the
      // source history but writes to a BRAND-NEW session id/file — the source `.jsonl` is
      // never mutated (no mtime bump, no divergence). Only valid when there's no live query.
      const shouldFork = !!forkFromSessionId && !existingSession?.query;

      // Resume if session has a session_id but no active query
      // (unified cleanup always sets query=null when for-await exits)
      const shouldResume = !shouldFork && !!existingSession?.session_id && !existingSession?.query;

      if (shouldFork) {
        console.log(
          `[ClaudeService] [${userId}] FORK mode — forking from CC session ${forkFromSessionId} into a new session for ${chatId}`
        );
      }

      let promptGenerator: string | AsyncIterableIterator<SDKUserMessage>;
      let inputQueue: MessageQueue<SDKUserMessage> | undefined;

      if (shouldResume) {
        // CASE 2: Resume — session_id exists but query is null
        console.log(
          `[ClaudeService] [${userId}] RESUME mode — resuming session: ${existingSession.session_id}`
        );

        inputQueue = new MessageQueue<SDKUserMessage>();

        const messageContent = this.mediaProcessingService.formatMessageWithFiles(
          task,
          uploadedFiles
        );
        const initialMessage: SDKUserMessage = {
          type: 'user',
          message: { role: 'user', content: messageContent },
          session_id: existingSession.session_id || chatId,
          parent_tool_use_id: null,
        };

        promptGenerator = createMessageGenerator(initialMessage, inputQueue);
      } else {
        // CASE 3: Create new persistent session
        console.log(`[ClaudeService] [${userId}] CREATE mode — new persistent session`);

        inputQueue = new MessageQueue<SDKUserMessage>();

        const messageContent = this.mediaProcessingService.formatMessageWithFiles(
          task,
          uploadedFiles
        );
        const initialMessage: SDKUserMessage = {
          type: 'user',
          message: { role: 'user', content: messageContent },
          session_id: chatId,
          parent_tool_use_id: null,
        };

        promptGenerator = createMessageGenerator(initialMessage, inputQueue);
      }

      console.log(`[ClaudeService] [${userId}] Starting SDK query (workspace: ${repoPath})`);

      // Build all MCP servers configuration via McpService
      const { mcpServers, tunnelMappings: mappings } = await this.mcpService.buildAllMcpServers({
        toolContext,
        repoPath,
        userId,
        chatId,
        playwrightDevice,
        agentSetupId,
      });
      tunnelMappings = mappings;

      // Add custom AskUser MCP server with callbacks that have access to this session's context
      this.askUserMcpServer = createAskUserMcpServer({
        onQuestionsReady: async (requestId: string, questions: any[]) => {
          // Transform questions to expected format
          // Claude often sends: { type, id, question, options: string[] }
          // The client expects: { question, header, multiSelect, options: {label, description}[] }
          const transformedQuestions = questions.map((q: any, index: number) => {
            // If already in correct format, return as-is
            if (
              q.header &&
              typeof q.multiSelect === 'boolean' &&
              Array.isArray(q.options) &&
              q.options.length > 0 &&
              typeof q.options[0] === 'object' &&
              q.options[0].label
            ) {
              return q;
            }

            // Transform from Claude's format
            return {
              question: q.question || `Question ${index + 1}`,
              header: q.id || `Q${index + 1}`,
              multiSelect: q.type === 'multiselect' || q.type === 'checkbox' || false,
              options: Array.isArray(q.options)
                ? q.options.map((opt: any) => {
                    if (typeof opt === 'string') {
                      return { label: opt, description: opt };
                    }
                    return {
                      label: opt.label || opt.value || opt,
                      description: opt.description || opt.label || opt.value || opt,
                    };
                  })
                : [],
            };
          });

          // Send notification to the client via WebSocket
          ws.send(
            JSON.stringify({
              type: 'ask_user_question',
              chat_id: chatId,
              request_id: requestId,
              questions: transformedQuestions,
            })
          );

          // NOTE: Socket.IO broadcast happens in the intercept block during streaming
          // to work around SDK MCP bug where questions aren't passed to handler
        },
      });

      mcpServers.user = this.askUserMcpServer;
      const finalSystemPrompt = systemPrompt;

      // Prepare permission mode and model
      // Map the client's underscore format to SDK camelCase format
      const mapPermissionMode = (frontendMode?: string): PermissionMode => {
        const mapping: Record<string, PermissionMode> = {
          default: 'default',
          plan: 'plan',
          accept_edits: 'acceptEdits',
          bypass_permissions: 'bypassPermissions',
        };

        // NO FALLBACKS - fail fast if mode is invalid
        if (!frontendMode) {
          throw new Error(
            `[ClaudeService] [${userId}] No permission mode provided. This is a bug - frontend must always specify a permission mode.`
          );
        }

        const sdkMode = mapping[frontendMode];
        if (!sdkMode) {
          throw new Error(
            `[ClaudeService] [${userId}] Unknown permission mode: '${frontendMode}'. Valid modes: ${Object.keys(mapping).join(', ')}. This is a bug - check frontend PermissionMode values.`
          );
        }

        return sdkMode;
      };
      const permMode = mapPermissionMode(permissions);
      const selectedModel = model || DEFAULT_MODEL_MODE;

      // Note: GitHub operations use gh CLI via Bash tool
      // No need to manage GitHub tokens in ClaudeService

      // Configure git user identity for commits made by Claude Agent SDK
      // This ensures commits are attributed to the actual user, not "Claude <noreply@anthropic.com>"
      // REQUIRED: username must be provided to ensure proper git attribution
      if (!username) {
        throw new Error(
          `[ClaudeService] [${userId}] FATAL: GitHub username is required for Claude sessions. ` +
            `This prevents commits from being attributed to 'Claude'. ` +
            `Ensure username is passed from SocketIOService via JWT payload.`
        );
      }

      // Resolve the git author identity from the user's active GitHub connection so
      // commits are attributed to their real GitHub account (login + noreply email),
      // not the Clerk display name carried in the JWT. Falls back to the JWT
      // username when no GitHub connection exists yet. Auth-path-agnostic: identical
      // behaviour whether the JWT was minted via Clerk or direct GitHub OAuth.
      const authorIdentity = await resolveGitAuthorIdentity(this.connectionsService, {
        userId,
        authToken,
        fallbackUsername: username,
      });

      // Never clobber the repo owner: keep their existing git identity when we only
      // have the fallback (PC hostname); see chooseGitIdentityToWrite.
      let gitAuthorName = authorIdentity.name;
      let gitEmail = authorIdentity.email;

      try {
        const gitDir = path.join(repoPath, '.git');
        const gitDirExists = fsSync.existsSync(gitDir);
        const repoDirExists = fsSync.existsSync(repoPath);

        // CRITICAL: Validate directory exists before running git config
        // Without this check, execSync with invalid cwd can fall back to current directory,
        // polluting the server's own git config (e.g., setting user to 'testuser' in tests)
        if (!repoDirExists) {
          throw new Error(
            `Repository directory does not exist: ${repoPath}. Cannot configure git user identity.`
          );
        }

        if (!gitDirExists) {
          throw new Error(
            `Not a git repository (missing .git directory): ${repoPath}. Cannot configure git user identity.`
          );
        }

        // Only read the repo's existing owner when we'd otherwise overwrite it with the
        // fallback (a real GitHub login is always written).
        const existing: ExistingGitIdentity | null =
          authorIdentity.source === 'fallback' ? readExistingGitIdentity(repoPath) : null;
        const decision = chooseGitIdentityToWrite(authorIdentity, existing);
        gitAuthorName = decision.name;
        gitEmail = decision.email;

        if (decision.write) {
          if (authorIdentity.source === 'fallback') {
            console.warn(
              `[ExecutionHandler] [${userId}] git author fell back to "${username}" ` +
                `(no GitHub login, no existing git identity); writing it so commits aren't attributed to "Claude".`
            );
          }
          execSync(`git config user.name "${gitAuthorName}"`, { cwd: repoPath });
          execSync(`git config user.email "${gitEmail}"`, { cwd: repoPath });
        } else {
          console.log(
            `[ExecutionHandler] [${userId}] No GitHub login resolved; keeping the repo's existing git owner ` +
              `"${gitAuthorName} <${gitEmail}>" (not overwriting it with the fallback "${username}").`
          );
        }
      } catch (error) {
        throw new Error(
          `[ClaudeService] [${userId}] Failed to configure git user at ${repoPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Sync the git env vars to the decided identity — always, so a stale GIT_AUTHOR_*
      // from a previous chat in this long-lived process can't override the repo config.
      process.env.GIT_AUTHOR_NAME = gitAuthorName;
      process.env.GIT_AUTHOR_EMAIL = gitEmail;
      process.env.GIT_COMMITTER_NAME = gitAuthorName;
      process.env.GIT_COMMITTER_EMAIL = gitEmail;

      // Resolve whether commits should carry the AI co-author trailer.
      // Defaults to true (the SDK default — behaviour unchanged for everyone who
      // never touched the toggle); only an explicit user opt-out ("non-AI-co-author
      // mode") disables it. Read from the per-user settings persisted in
      // user_themes.theme_config.userSettings via the shared dbAdapter; never throws.
      const includeCoAuthoredBy = await resolveIncludeCoAuthoredBy(this.chatService?.dbAdapter, {
        userId,
        authToken,
      });

      // Extension: when the AI co-author trailer is enabled, ALSO stamp every
      // commit in this repo with Portable's own brand trailer
      // (`Co-Authored-By: Portable Dev <portable@volter.ai>`, the github.com/portable-one
      // account) via a prepare-commit-msg git hook — the SDK can only toggle its Claude
      // trailer, not emit a custom co-author. So an enabled commit ends up with BOTH
      // (Claude + Portable). When disabled the hook is removed, so the commit carries no
      // co-author at all (the SDK's Claude trailer is already turned off below). Best-effort
      // — never throws, so attribution can never break a session.
      syncPortableCoAuthorHook(repoPath, includeCoAuthoredBy);

      // Claude Agent SDK 0.3.x kills in-process (createSdkMcpServer) tool streams
      // after 60s by default. Our custom tools block on user input far longer than
      // that — ask_user (multiple-choice prompt), request_user_secrets, and
      // request_user_connection all wait on the human; the permission callback alone
      // allows 5 minutes. Raise the stream-close timeout to 10 minutes so these tools
      // aren't severed mid-wait.
      process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT =
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || '600000';

      // Local-first: resolve the user's OWN Anthropic credential and call DIRECT.
      if (this.localAiCredentialsService) {
        // Local-first direct mode: resolve the user's OWN credential
        // from the local encrypted store / local config — Claude subscription OAuth
        // (→ CLAUDE_CODE_OAUTH_TOKEN) or a raw ANTHROPIC_API_KEY. Never a JWT claim.
        // applyToProcessEnv also clears ANTHROPIC_BASE_URL so calls hit the default
        // https://api.anthropic.com (any prior proxy shim URL is dropped).
        const mode = this.localAiCredentialsService.applyToProcessEnv();
        console.log(
          `[ClaudeService] [${userId}] 🏠 LOCAL MODE: AI credential = ${mode} (local, no JWT claim)`
        );
      } else {
        // Fallback (no local credential service injected): ANTHROPIC_API_KEY from .env.
        if (!ANTHROPIC_API_KEY) {
          throw new Error(
            `[ClaudeService] [${userId}] FATAL: Direct API mode but ANTHROPIC_API_KEY not found.\n` +
              `Set ANTHROPIC_API_KEY in your .env file.`
          );
        }

        process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;

        // Clear any baseURL override so direct mode always hits Anthropic's
        // default endpoint.
        delete process.env.ANTHROPIC_BASE_URL;
      }

      const result = query({
        prompt: promptGenerator,
        options: {
          cwd: repoPath,
          // Load the PROJECT filesystem config for the cwd repo (`.mcp.json`,
          // `.claude/settings.json`, CLAUDE.md) so a repo's OWN configured MCP
          // servers connect — e.g. an `.mcp.json` declaring an http MCP server.
          // `strictMcpConfig` is left UNSET (false), so the project `.mcp.json`
          // `mcpServers` MERGE with the built-in `mcpServers` below (they don't
          // replace them). Only the 'project' tier — NOT 'user'/'local'.
          // ⚠️ This ALSO loads the repo's `.claude/settings.json` hooks +
          // permissions (a repo's PreToolUse hook will now run); the api's
          // explicit flag-tier options below (allowed/disallowedTools, the
          // co-author `settings`) still take precedence over project settings.
          settingSources: ['project'],
          // Turn skills ON. The `skills` option is the SINGLE place to
          // enable skills (you must NOT add `'Skill'` to allowedTools — deprecated).
          // `'all'` enables EVERY DISCOVERED skill — both the cwd repo's own
          // `.claude/skills/*` (project tier) AND the user's global
          // `~/.claude/skills/*` (+ enabled local plugins). The SDK resolves the
          // host's REAL `~/.claude` because `CLAUDE_CONFIG_DIR` is never set.
          // Skill DISCOVERY is directory-driven and ORTHOGONAL to
          // `settingSources`, so we KEEP `settingSources: ['project']` (LOCKED:
          // do NOT add the `'user'` tier — that would import the user's global
          // `settings.json` hooks + permissions, not just their skills' capabilities).
          skills: 'all',
          // FORK-ON-FIRST-WRITE: `resume` the ORIGINAL CC session but `forkSession: true`
          // so the SDK mints a NEW session id and writes a NEW transcript, leaving the
          // source `.jsonl` untouched (read-only). The new id is captured on `system/init`
          // below and persisted to this chat's row, after which it resumes normally.
          // Otherwise add plain `resume` for a server-restart resume of our own session.
          ...(shouldFork && forkFromSessionId
            ? { resume: forkFromSessionId, forkSession: true }
            : shouldResume && existingSession?.session_id
              ? { resume: existingSession.session_id }
              : {}),
          mcpServers,
          // Whitelist custom ask_user tool and block native AskUserQuestion
          allowedTools: [
            'mcp__playwright__*',
            'mcp__user__ask_user', // Our custom AskUserQuestion implementation
          ],
          disallowedTools: [
            'AskUserQuestion', // Block native tool (doesn't work in SDK subprocess)
            // SDK 0.3.x ships agent-harness / scheduling tools that don't belong in
            // an interactive user coding sandbox (no client rendering, and they'd
            // create cron jobs, push notifications, or wake-ups against the sandbox).
            // Task* (todo list), Web*, EnterPlanMode/ExitPlanMode, REPL and Workflow
            // are intentionally left enabled. Reconcile against the SDK-init `tools`
            // log in staging.
            'CronCreate',
            'CronDelete',
            'CronList',
            'RemoteTrigger',
            'PushNotification',
            'Monitor',
            'ScheduleWakeup',
          ],
          permissionMode: permMode,
          model: selectedModel,
          // When the user turned the AI co-author OFF, inject the disable via
          // the SDK's inline "flag settings" layer (the `--settings` tier — highest
          // priority among user-controlled settings, so it still wins over any
          // project `.claude/settings.json` now loaded via settingSources:['project']).
          // When ON (default) we add nothing, so the SDK keeps its default trailer.
          ...(includeCoAuthoredBy ? {} : { settings: { includeCoAuthoredBy: false } }),
          systemPrompt: finalSystemPrompt,
          // Build agents configuration dynamically from agent setup
          agents: this.agentHandler.buildAgentsFromSetup(agentSetupId, repoPath),
          // Hook to detect context compaction
          hooks: {
            PreCompact: [
              {
                hooks: [
                  async (_input: any) => {
                    const compressingMsg = {
                      type: 'chat_status_update',
                      chat_id: chatId,
                      status: 'compressing' as const,
                    };
                    ws.send(JSON.stringify(compressingMsg));

                    // Update in database
                    this.chatService.updateChatStatus(
                      chatId,
                      userId,
                      'compressing' as const,
                      authToken
                    );
                    await this.chatService.bufferMessage(
                      userId,
                      chatId,
                      'chat_status_update',
                      {
                        status: 'compressing',
                      },
                      authToken
                    );

                    // Set flag to mark next message as post-compression
                    this.postCompressionFlags.set(chatId, true);

                    return { continue: true }; // Return HookJSONOutput
                  },
                ],
              },
            ],
          },
          // Permission callback - fires when SDK needs user approval for tool use
          canUseTool: async (toolName: string, toolInput: any) => {
            const requestId = `${chatId}-${Date.now()}-${Math.random().toString(36).substring(7)}`;

            // Create a promise that will be resolved when user responds
            return new Promise((resolve) => {
              // Store the resolver
              this.permissionRequests.set(requestId, {
                resolve,
                toolName,
                toolInput,
                chatId,
                timestamp: Date.now(),
              });

              // Store pending permission for matching with tool_use block
              const pendingKey = `${chatId}:${toolName}`;
              this.pendingPermissions.set(pendingKey, requestId);

              ws.send(
                JSON.stringify({
                  type: 'tool_permission_required',
                  chat_id: chatId,
                  request_id: requestId,
                  tool_name: toolName,
                  tool_input: toolInput,
                })
              );

              // Set timeout (5 minutes)
              setTimeout(
                () => {
                  const request = this.permissionRequests.get(requestId);
                  if (request) {
                    console.warn(
                      `[ClaudeService] [${userId}] Permission request ${requestId} timed out`
                    );
                    this.permissionRequests.delete(requestId);
                    resolve({
                      behavior: 'deny',
                      message: 'Permission request timed out after 5 minutes',
                    });
                  }
                },
                5 * 60 * 1000
              );
            });
          },
        },
      });

      // Store session in map with the message queue
      this.claudeCodeSessions.set(chatId, {
        repo_path: repoPath,
        session_id: shouldResume ? existingSession.session_id : null, // Resume uses existing ID
        query: result,
        messageQueue,
        inputQueue, // Store the inputQueue for message injection
        signal,
        resolveNextMessage: null,
        systemPrompt: finalSystemPrompt,
        userId, // Store userId for tunnel cleanup on stop
        model, // Store model selection
        permissions, // Store permissions mode
        isProcessing: true,
        lastActivityAt: Date.now(), // idle-reaper activity tracking
        authToken,
      });

      // A brand-new (or resumed) live session just entered the map → surface it
      // in the runtime panel immediately. The 'running' chat_status_update
      // above is sent BEFORE this set(), so it can't carry the new session — this
      // is the first point the session is enumerable by getClaudeSessionInfos.
      this.emitRuntimeStateRefresh(ws, chatId);

      for await (const message of result) {
        // Check if session has been stopped (interrupt button pressed)
        const session = this.claudeCodeSessions.get(chatId);
        if (session?.signal.stopped) {
          console.log(
            `[ClaudeService] [${userId}] ⛔ Session ${chatId} stopped by user - breaking query loop`
          );
          break;
        }

        // Check if this is a system init message with session ID
        if (
          message &&
          typeof message === 'object' &&
          (message as any).type === 'system' &&
          (message as any).subtype === 'init'
        ) {
          // Log the enabled tool surface + MCP server statuses once per session.
          // SDK 0.3.x exposes many new builtin tools (Cron*, RemoteTrigger, Monitor,
          // Workflow, worktree, etc.). Use this to confirm/extend `disallowedTools`
          // and to verify MCP servers connected (background-connect is default since
          // 0.3.142).
          try {
            const initTools = (message as any).tools;
            const initMcp = (message as any).mcp_servers;
            console.log(
              `[ClaudeService] [${userId}] SDK init — tools: ${
                Array.isArray(initTools) ? initTools.join(', ') : 'n/a'
              }`
            );
            console.log(
              `[ClaudeService] [${userId}] SDK init — mcp_servers: ${
                Array.isArray(initMcp) ? JSON.stringify(initMcp) : 'n/a'
              }`
            );
            // Log the RESOLVED skill list so staging/device can confirm BOTH
            // the repo's own `.claude/skills/*` AND the user's global `~/.claude/skills/*`
            // were discovered + enabled by `skills: 'all'`.
            const initSkills = (message as any).skills;
            console.log(
              `[ClaudeService] [${userId}] SDK init — skills: ${
                Array.isArray(initSkills)
                  ? initSkills.length
                    ? initSkills.join(', ')
                    : 'none'
                  : 'n/a'
              }`
            );
            // Capture the SDK's AUTHORITATIVE slash-command + skill list for this
            // repo cwd so `GET /api/chats/:chatId/commands` (the mobile `/` picker)
            // offers exactly what will actually execute — never a global command
            // that `settingSources: ['project']` doesn't load.
            slashCommandRegistry.record(repoPath, {
              slashCommands: (message as any).slash_commands,
              skills: initSkills,
            });
          } catch {
            // best-effort logging only
          }

          const sessionId = (message as any).session_id;
          const session = this.claudeCodeSessions.get(chatId);
          if (session) {
            session.session_id = sessionId;
            // Save session info to database (with authToken for RLS)
            await this.chatService.updateChatSession(
              chatId,
              userId,
              sessionId,
              finalSystemPrompt,
              authToken
            );
          }
          continue;
        }

        // Check if this is a result message
        if (message && typeof message === 'object' && (message as any).type === 'result') {
          const session = this.claudeCodeSessions.get(chatId);
          if (session) {
            session.isProcessing = false;
            // Turn complete → idle clock starts here for the reaper.
            session.lastActivityAt = Date.now();
          }

          // Send "idle" status for persistent sessions (not "completed")
          // Session is still alive, just waiting for next message
          const idleMessage = {
            type: 'chat_status_update',
            chat_id: chatId,
            status: 'idle',
          };
          ws.send(JSON.stringify(idleMessage));

          // Turn complete → session is now idle (between-turns, still live).
          // Refresh the panel so it shows the idle badge + starts the idle
          // countdown the reaper uses. isProcessing is already false here.
          this.emitRuntimeStateRefresh(ws, chatId);

          // Don't update database status - session is still active
          await this.chatService.bufferMessage(
            userId,
            chatId,
            'chat_status_update',
            {
              status: 'idle',
            },
            authToken
          );

          // Extract actions from the last assistant message (now awaited to prevent race conditions)
          // Previously had setTimeout with 500ms delay - no longer needed since persistence is awaited
          try {
            await this.actionHandler.extractAndSendActions(userId, chatId, ws, authToken);
          } catch (err: any) {
            loudError({
              title: 'Action Extraction Failed',
              severity: 'critical',
              context: { chatId, userId },
              error: err,
            });
          }

          continue;
        }

        // Extract and process blocks from the message
        const currentSession = this.claudeCodeSessions.get(chatId);
        const blocks = await this.streamHandler.processStreamMessage(
          message,
          repoPath,
          chatId,
          ws,
          userId,
          currentSession?.session_id || undefined
        );

        // Stream blocks to client
        if (blocks.length > 0) {
          // Check if this is the first message after compression
          const isPostCompression = this.postCompressionFlags.get(chatId) || false;
          if (isPostCompression) {
            this.postCompressionFlags.delete(chatId);

            // Reset status back to running after compression completes
            const runningMsg = {
              type: 'chat_status_update',
              chat_id: chatId,
              status: 'running' as const,
            };
            ws.send(JSON.stringify(runningMsg));

            // Update in database
            this.chatService.updateChatStatus(chatId, userId, 'running' as const, authToken);
            await this.chatService.bufferMessage(
              userId,
              chatId,
              'chat_status_update',
              {
                status: 'running',
              },
              authToken
            );
          }

          const prunedBlocks = blocks;

          // Check if this message is from a sub-agent (has parent_tool_use_id)
          const parentToolUseId = (message as any).parent_tool_use_id;
          const subAgentInfo = parentToolUseId
            ? this.activeSubAgents.get(parentToolUseId)
            : undefined;

          const streamMessage: any = {
            type: 'claude_code_stream',
            chat_id: chatId,
            tool_use_id: parentToolUseId || chatId,
            blocks: prunedBlocks,
            event: message,
            isPostCompression, // Add flag to message
          };

          // Add agent metadata if this is from a sub-agent
          if (parentToolUseId && subAgentInfo) {
            streamMessage.agentName = subAgentInfo.name;
            streamMessage.agentType = subAgentInfo.type;
            streamMessage.isSubAgent = true;
            streamMessage.parentToolUseId = parentToolUseId;
          }

          ws.send(JSON.stringify(streamMessage));

          // Buffer each block individually for proper Redis storage and client reconstruction
          for (const block of blocks) {
            await this.chatService.bufferMessage(
              userId,
              chatId,
              'claude_code_block',
              block,
              authToken
            );
          }
        }
      }

      console.log(`[ClaudeService] [${userId}] for-await loop exited (chatId: ${chatId})`);
    } catch (error: any) {
      // Store error for finally block to handle
      sessionError = error;
      console.error(`[ClaudeService] [${userId}] Error in session ${chatId}:`, error.message);
    } finally {
      // ============================================================
      // UNIFIED SESSION CLEANUP — runs after for-await loop exits
      // for ANY reason (normal exit, user stop, error, subprocess death)
      // ============================================================
      const session = this.claudeCodeSessions.get(chatId);
      if (session) {
        const wasInterrupted = session.signal.stopped;

        // Abort queue if still open (prevents generator from feeding dead subprocess)
        if (session.inputQueue && !session.inputQueue.isClosed()) {
          session.inputQueue.abort();
        }

        // Always clean execution state — makes session resumable
        session.query = null;
        session.inputQueue = undefined;
        session.isProcessing = false;
        // session_id preserved for resume

        console.log(
          `[ClaudeService] [${userId}] Session ${chatId} cleaned (wasInterrupted=${wasInterrupted}, session_id=${session.session_id})`
        );

        // Clean up permission requests for this chat
        for (const [requestId, request] of this.permissionRequests.entries()) {
          if (request.chatId === chatId) {
            this.permissionRequests.delete(requestId);
            this.pendingPermissions.delete(`${chatId}:${request.toolName}`);
          }
        }

        // Send appropriate status to the client + persist
        if (sessionError) {
          // Error path — send error to the client
          const isProcessTransportError = sessionError.message?.includes(
            'ProcessTransport is not ready'
          );
          const isProcessExitError = sessionError.message?.includes('process exited');

          if (isProcessTransportError || isProcessExitError) {
            loudError({
              title: isProcessTransportError
                ? 'Agent SDK ProcessTransport Died'
                : 'Claude Code Process Exited',
              severity: 'critical',
              context: {
                chatId,
                userId,
                sessionId: session.session_id,
                error: sessionError.message,
              },
              error: sessionError,
              suggestions: [
                'User can retry by sending a new message',
                'Session will be resumed with same session_id (conversation preserved)',
              ],
            });

            ws.send(
              JSON.stringify({
                type: 'agent_error',
                chat_id: chatId,
                error: {
                  title: isProcessTransportError ? 'Session Disconnected' : 'Session Error',
                  message: isProcessTransportError
                    ? 'The AI session timed out after being idle. Your conversation will continue when you send a new message.'
                    : 'The AI session ended unexpectedly. Your conversation will continue when you send a new message.',
                  action: 'Please send your message again to resume.',
                  canRetry: true,
                },
              })
            );

            ws.send(
              JSON.stringify({
                type: 'chat_status_update',
                chat_id: chatId,
                status: 'error',
              })
            );

            this.chatService.updateChatStatus(chatId, userId, 'error', authToken);
            await this.chatService.bufferMessage(
              userId,
              chatId,
              'error_message',
              {
                content: isProcessTransportError
                  ? '⚠️ Session disconnected due to inactivity. Send a new message to continue.'
                  : '⚠️ AI session ended unexpectedly. Send a new message to continue.',
                timestamp: Date.now(),
              },
              authToken
            );
          } else {
            // Unknown error — flag for rethrow after finally completes
            // (cannot throw in finally — `no-unsafe-finally` ESLint rule)
          }
        } else if (wasInterrupted) {
          // User stop path
          ws.send(JSON.stringify({ type: 'claude_code_interrupted', chat_id: chatId }));
          this.chatService.updateChatStatus(chatId, userId, 'completed', authToken);
          await this.chatService.bufferMessage(
            userId,
            chatId,
            'chat_status_update',
            { status: 'completed' },
            authToken
          );
        } else {
          // Natural exit (subprocess died silently, no error thrown)
          ws.send(
            JSON.stringify({
              type: 'chat_status_update',
              chat_id: chatId,
              status: 'idle',
            })
          );
          await this.chatService.bufferMessage(
            userId,
            chatId,
            'chat_status_update',
            { status: 'idle' },
            authToken
          );
        }

        // Session torn down (query=null / inputQueue=undefined above) → it is no
        // longer enumerable, so drop it from the runtime panel. Covers
        // natural exit, error, AND silent subprocess death; idempotent with the
        // reaper/kill broadcasts (those already filtered it via signal.stopped).
        this.emitRuntimeStateRefresh(ws, chatId);
      }

      // Cleanup: Destroy all local tunnels that were created
      if (tunnelMappings.length > 0 && this.tunnelService) {
        for (const tunnel of tunnelMappings) {
          try {
            await this.tunnelService.destroyLocalTunnel(tunnel.port);
          } catch (err) {
            console.error(
              `[ClaudeService] [${userId}] Tunnel cleanup failed for port ${tunnel.port}:`,
              err
            );
          }
        }
      }
    }

    // Rethrow unknown errors after finally cleanup completed
    if (sessionError) {
      const isHandled =
        sessionError.message?.includes('ProcessTransport is not ready') ||
        sessionError.message?.includes('process exited');
      if (!isHandled) {
        throw sessionError;
      }
    }
  }

  /**
   * Emit a runtime-state refresh through the output adapter.
   *
   * Routed by ChatExecutionService.createOutputAdapter's `runtime_state_update`
   * branch → emitter.broadcastRuntimeStateToUser(userId), which pushes a fresh full
   * `user:runtime_state` snapshot (including live Claude sessions) to ALL of the
   * user's connected sockets. Going through the emitter abstraction keeps this a
   * no-op for headless/routine execution (NoOpEmitter has no broadcast method).
   *
   * Called at every Claude-session lifecycle transition (create/resume, inject,
   * turn-complete → idle, teardown) so the runtime panel reflects sessions live
   * without a reconnect/restart. Previously the panel only refreshed on
   * tunnel/reap/kill/connect events, so a freshly created chat's
   * session never appeared until the client reconnected.
   */
  private emitRuntimeStateRefresh(ws: WebSocket, chatId: string): void {
    try {
      ws.send(JSON.stringify({ type: 'runtime_state_update', chat_id: chatId }));
    } catch {
      // Non-fatal — a dead adapter/socket must never break session execution.
    }
  }

  /**
   * Add a message to a running session's queue
   */
  addMessageToSession(chatId: string, content: string | any[], _userId: string): boolean {
    const session = this.claudeCodeSessions.get(chatId);

    if (!session || !session.query || !session.inputQueue) {
      return false;
    }

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      session_id: session.session_id || chatId,
      parent_tool_use_id: null,
    };

    try {
      session.inputQueue.enqueue(userMessage);
    } catch {
      return false;
    }

    session.isProcessing = true;
    session.lastActivityAt = Date.now(); // idle-reaper activity tracking
    return true;
  }

  /**
   * Stop a running Claude Code session
   * Closes the inputQueue → iterator ends → cleanup fires → background processes killed
   * IMPORTANT: Removes session from map to force fresh session creation (for permission mode changes)
   */
}
