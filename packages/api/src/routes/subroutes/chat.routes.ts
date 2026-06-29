import { shouldLog } from '@vgit2/shared/constants';
import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';
import { Router } from 'express';

import { FEATURE_FLAGS } from '../../config/featureFlags.js';
import { requireAuth } from '../../middleware/auth.js';
import { ChatAnalysisService } from '../../services/ChatAnalysisService.js';
import { CommandsService } from '../../services/CommandsService.js';
import { getAuthToken, extractMessagePreview } from '../utils/route-helpers.js';

import type { LocalAiHelper } from '../../services/ai/LocalAiHelper.js';
import type { ChatService } from '../../services/ChatService.js';
import type { ClaudeService } from '../../services/ClaudeService.js';
import type { GitHubApiService } from '../../services/GitHubApiService.js';
import type { IntentAnalysisService } from '../../services/IntentAnalysisService.js';
import type { SuggestionsService } from '../../services/SuggestionsService.js';
import type {
  GetChatsResponse,
  CreateChatResponse,
  GetChatMessagesResponse,
  SendChatMessageResponse,
  GetChatStatusResponse,
  GetChatCommandsResponse,
  SummarizeChatResponse,
  AnalyzeIntentResponse,
  GetSuggestionsResponse,
  GenerateProjectNameResponse,
} from '@vgit2/shared/types';

/**
 * Chat management and messaging routes
 */
export function createChatRoutes(
  chatService: ChatService,
  intentAnalysisService: IntentAnalysisService,
  suggestionsService: SuggestionsService,
  githubApiService: GitHubApiService,
  claudeCodeSessions: Map<string, any>,
  sopService?: any,
  claudeService?: ClaudeService,
  localAiHelper?: LocalAiHelper
): Router {
  const router = Router();
  // Stateless enumerator for the `/` slash-command picker (reads the shared
  // slashCommandRegistry + scans the cwd repo's `.claude` dirs); no DI needed.
  const commandsService = new CommandsService();

  router.get('/chats', requireAuth, async (req, res) => {
    // Check authentication and allowlist status
    if (!req.session.userEmail) {
      console.log('[API] /api/chats - Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.session.onWaitlist) {
      console.log('[API] /api/chats - User on waitlist, access denied');
      return res.status(403).json({ error: 'Access denied - on waitlist' });
    }

    try {
      // Parse limit and offset from query params
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200); // default: 50, max: 200
      const offset = parseInt(req.query.offset as string) || 0; // default: 0

      // Parse archived filter from query params (true, false, or undefined for all)
      let archived: boolean | undefined;
      if (req.query.archived === 'true') {
        archived = true;
      } else if (req.query.archived === 'false') {
        archived = false;
      }

      // 3-way category filter (mobile): active / saved / archived. When present it
      // supersedes `archived` (active = not archived AND not saved). The terminal sends
      // only `archived`, so its behavior is unchanged.
      const categoryParam = req.query.category;
      const category =
        categoryParam === 'active' || categoryParam === 'saved' || categoryParam === 'archived'
          ? categoryParam
          : undefined;

      // `source=portable` (terminal-only): return ONLY portable-native chats (real
      // SQLite rows opened + messaged in Portable), excluding imported ~/.claude/projects
      // transcripts. The mobile app does NOT send this, so its behavior is unchanged.
      const portableOnly = req.query.source === 'portable';

      // Extract JWT from Authorization header for request auth
      const authToken = getAuthToken(req);

      // Get total count of chats for pagination (with filter applied)
      const allChats = await chatService.getChats(
        req.session.userEmail,
        authToken,
        archived,
        portableOnly,
        category
      );
      const totalCount = allChats.length;
      const hasMore = offset + limit < totalCount;

      // `previews=false` LITE path (terminal): return the chat rows as-is — id, title,
      // repoFullName, lastUpdated — WITHOUT reading each chat's transcript to build
      // message previews/counts. The terminal doesn't render previews, and reading the
      // (potentially large) JSONL transcript per chat on every poll is the slow part.
      if (req.query.previews === 'false') {
        const page = allChats.slice(offset, offset + limit);
        return res.json({ chats: page, hasMore, totalCount });
      }

      // Use optimized query that fetches chats with message counts and previews in 4 queries total
      // (instead of 1 + 2*N queries where N is the number of chats)
      const chats = await chatService.dbAdapter.getChatsWithPreviews(
        req.session.userEmail,
        limit,
        offset,
        authToken,
        archived,
        portableOnly,
        category
      );

      // Compact log at INFO level
      console.log(`[API] /api/chats → ${chats.length}/${totalCount} (offset: ${offset})`);

      // Verbose details at DEBUG level
      if (shouldLog('debug')) {
        console.log(`[API] Fetching chats for user: ${req.session.userEmail} (limit: ${limit})`);
        console.log(`[API] Has more: ${hasMore}`);
      }

      // Convert stored chats to the client format and include totalCount
      // Use Promise.allSettled to prevent one bad chat from breaking all chats
      const formattedChatsResults = await Promise.allSettled(
        chats.map(async (chat) => {
          // Check if session is actually running in memory
          // Match the logic from chat:join handler (SocketIOService.ts lines 364-381)
          const session = claudeCodeSessions.get(chat.id);
          let actualStatus: string;
          if (!session || !session.query) {
            // No session in memory - use completed
            actualStatus = 'completed';
          } else if (session.signal?.stopped) {
            // Session is being stopped
            actualStatus = 'completed';
          } else if (session.isProcessing) {
            // Session exists and is actively processing
            actualStatus = 'running';
          } else {
            // Session exists but is idle (waiting for next message)
            actualStatus = chat.status === 'idle' ? 'idle' : 'completed';
          }

          // Message count and previews are already included from getChatsWithPreviews()
          const totalCount = chat.message_count || 0;

          // Extract message previews from the pre-fetched data
          let firstMessagePreview: string | undefined;
          let lastMessagePreview: string | undefined;

          if (chat.first_message_data) {
            firstMessagePreview = extractMessagePreview(chat.first_message_data);
            // Debug: Log if customDisplay exists
            if (shouldLog('debug') && chat.first_message_data.customDisplay) {
              console.log(
                `[API] Chat ${chat.id} first message has customDisplay:`,
                chat.first_message_data.customDisplay
              );
            }
          }

          if (chat.last_message_data) {
            lastMessagePreview = extractMessagePreview(chat.last_message_data);
            // Debug: Log if customDisplay exists
            if (shouldLog('debug') && chat.last_message_data.customDisplay) {
              console.log(
                `[API] Chat ${chat.id} last message has customDisplay:`,
                chat.last_message_data.customDisplay
              );
            }
          }

          // Validate permissions - if missing, log error and skip this chat
          if (!chat.permissions) {
            console.error(
              `[API] ❌ Chat ${chat.id} has no permissions set - skipping this chat (title: "${chat.title}")`
            );
            throw new Error(`Chat ${chat.id} missing permissions`);
          }

          // Parse linked issue if it exists.
          // The active JsonDbAdapter stores linked_issue as a native object;
          // legacy rows store it as a JSON string (text column). Handle both,
          // and ignore malformed values without throwing.
          let linkedIssue = undefined;
          if (chat.linked_issue) {
            if (typeof chat.linked_issue === 'string') {
              try {
                linkedIssue = JSON.parse(chat.linked_issue);
              } catch (e) {
                console.error(`[API] Failed to parse linked_issue for chat ${chat.id}:`, e);
              }
            } else if (typeof chat.linked_issue === 'object') {
              linkedIssue = chat.linked_issue;
            }
          }

          // Note: routine_id is a deprecated/vestigial DB column (the Routines feature
          // was removed). It is no longer surfaced in the API response —
          // the mobile client never read routineId/routineName. The column read is dropped
          // here too since it was only used to build those dead response fields.

          return {
            id: chat.id,
            type: chat.type,
            title: chat.title,
            messages: [], // Messages are loaded separately via polling (uses Task tool logic in getMessagesAfterId)
            status: actualStatus, // Use actual runtime status instead of stale DB status
            hidden: Boolean(chat.hidden),
            archived: Boolean(chat.archived),
            saved: Boolean(chat.saved),
            pinned: Boolean(chat.pinned),
            lastUpdated: chat.last_updated,
            repo_path: chat.repo_path,
            repoFullName: chat.repoFullName ?? chat.repo_full_name ?? undefined, // GitHub owner/repo so the client shows the repo name, not a generic "Workspace" label
            playwrightDevice: (chat.playwright_device as 'mobile' | 'desktop') || 'mobile',
            lastReadMessageId: chat.last_read_message_id || undefined,
            totalCount,
            model: chat.model || DEFAULT_MODEL_MODE,
            permissions: chat.permissions, // Required - validated above
            agentSetupId: (chat as any).agentSetupId || chat.agent_setup_id, // Handle both camelCase (from adapter) and snake_case (legacy)
            linkedIssue, // Include linked issue if present
            firstMessagePreview, // Preview of first user message
            lastMessagePreview, // Preview of last message
          };
        })
      );

      // Filter out rejected chats and extract successful values
      const formattedChats = formattedChatsResults
        .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
        .map((result) => result.value);

      // Log if any chats were skipped
      const skippedCount = formattedChatsResults.length - formattedChats.length;
      if (skippedCount > 0) {
        console.warn(
          `[API] ⚠️  Skipped ${skippedCount} chat(s) due to validation errors (check logs above)`
        );
      }

      const response: GetChatsResponse = {
        chats: formattedChats,
        hasMore, // Whether there are more chats beyond the current page
        totalCount, // Total number of chats (for UI feedback)
      };
      res.json(response);
    } catch (error) {
      console.error('[API] Error fetching chats:', error);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  });

  // Create a new chat (for headless API)
  router.post('/chats', requireAuth, async (req, res) => {
    try {
      const { type, title, repoOwner, repoName, prompt, model, permissionMode } = req.body;

      // Validate required fields
      if (!type || !prompt) {
        return res.status(400).json({ error: 'Missing required fields: type, prompt' });
      }

      // Get user email from session
      const userEmail = req.session.userEmail!;

      console.log(`[API] POST /api/chats - Creating chat for user ${userEmail} (type: ${type})`);

      // Extract JWT from Authorization header for request auth
      const authToken = getAuthToken(req);

      // Generate chat ID
      const chatId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Create the chat in database
      const chatTitle = title || `${type === 'repo' ? `${repoOwner}/${repoName}` : 'General'} Chat`;
      const repoPath =
        type === 'repo' && repoOwner && repoName ? `${repoOwner}/${repoName}` : undefined;

      await chatService.dbAdapter.saveChat({
        userId: userEmail,
        chatId,
        type: 'claude_code', // All chats are claude_code type
        title: chatTitle,
        status: 'idle',
        repoPath, // Store repo info if this is a repo chat
        authToken,
      });

      console.log(`[API] POST /api/chats - Chat created: ${chatId}`);

      // Buffer the initial prompt message if provided
      if (prompt) {
        console.log(
          `[API] POST /api/chats - Buffering initial prompt: ${prompt.substring(0, 100)}...`
        );

        await chatService.bufferMessage(
          userEmail,
          chatId,
          'user_message',
          {
            role: 'user',
            content: prompt,
            timestamp: Date.now(),
            model: model || 'haiku',
            permissions: permissionMode || 'auto',
          },
          authToken
        );
      }

      // Return the chat
      const response: CreateChatResponse = {
        id: chatId,
        type,
        title: chatTitle,
        repoOwner,
        repoName,
      };
      return res.json(response);
    } catch (error) {
      console.error('[API] POST /api/chats error:', error);
      return res.status(500).json({ error: 'Failed to create chat' });
    }
  });

  // Get messages for a chat (long polling endpoint)
  router.get('/chats/:chatId/messages', requireAuth, async (req, res) => {
    // Disable ETag caching for long polling (prevents 304 Not Modified)
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('ETag', ''); // Explicitly disable ETag

    // Check authentication (allow internal auth without githubToken)
    if (!req.session.userEmail) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { chatId } = req.params;
    const after = (req.query.after as string) ? parseInt(req.query.after as string) : 0;
    const limit = (req.query.limit as string) ? parseInt(req.query.limit as string) : 50;
    const timeout = (req.query.timeout as string) ? parseInt(req.query.timeout as string) : 10000; // 10 seconds default

    // Extract JWT from Authorization header for request auth
    const authToken = getAuthToken(req);

    try {
      // Verify user owns this chat
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const chat = await chatService.getChat(chatIdStr, req.session.userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Long polling: Check for new messages, or wait until timeout
      const startTime = Date.now();
      const pollInterval = 200; // Check every 200ms

      const checkForMessages = async (): Promise<boolean> => {
        const messages = await chatService.getMessagesAfterId(chatIdStr, after, limit, authToken);

        if (messages.length > 0) {
          // Found new messages, send immediately
          const session = claudeCodeSessions.get(chatIdStr);
          const status =
            session && session.query && !session.signal?.stopped ? 'running' : 'completed';

          const response: GetChatMessagesResponse = {
            messages,
            hasMore: messages.length === limit,
            status,
          };
          res.json(response);
          return true;
        }

        return false;
      };

      // Try immediately first
      if (await checkForMessages()) {
        return;
      }

      // Set up long polling with interval checks
      const intervalId = setInterval(async () => {
        // Check if client disconnected
        if (res.writableEnded) {
          clearInterval(intervalId);
          return;
        }

        // Check if timeout reached
        if (Date.now() - startTime >= timeout) {
          clearInterval(intervalId);

          // Send empty response with current status
          const session = claudeCodeSessions.get(chatIdStr);
          const status =
            session && session.query && !session.signal?.stopped ? 'running' : 'completed';

          const response: GetChatMessagesResponse = {
            messages: [],
            hasMore: false,
            status,
          };
          res.json(response);
          return;
        }

        // Check for new messages
        const found = await checkForMessages();
        if (found) {
          clearInterval(intervalId);
        }
      }, pollInterval);

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(intervalId);
      });
    } catch (error) {
      console.error(`[API] Error fetching messages for chat ${chatId}:`, error);
      res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  // NOTE: Chat messaging, interrupts, and secrets are now handled via Socket.IO
  // See SocketIOService.ts for real-time chat operations
  // These HTTP endpoints have been removed in favor of Socket.IO events:
  // - chat:message (replaces POST /chats/:chatId/messages)
  // - claude:interrupt (replaces POST /chats/:chatId/interrupt)
  // - claude:submit_secrets (replaces POST /chats/:chatId/secrets)
  // - claude:cancel_secrets (replaces POST /chats/:chatId/secrets/cancel)

  // EXCEPTION: Headless API endpoints (for gateway → sandbox communication)
  // These REST endpoints are required for programmatic access via the headless API

  // Send a message to a chat (headless API)
  router.post('/chats/:chatId/messages', requireAuth, async (req, res) => {
    try {
      const { chatId } = req.params;
      const { content, model } = req.body;
      const userEmail = req.session.userEmail!;

      // Validate that content is provided
      if (!content || (typeof content === 'string' && content.trim().length === 0)) {
        return res.status(400).json({ error: 'Message content is required' });
      }

      console.log(`[API] POST /chats/${chatId}/messages - Sending message for user ${userEmail}`);

      // Extract JWT from Authorization header for request auth
      const authToken = getAuthToken(req);

      // Buffer the message
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      chatService.bufferMessage(
        userEmail,
        chatIdStr,
        'user_message',
        {
          role: 'user',
          content,
          timestamp: Date.now(),
          model: model || 'haiku',
          permissions: 'auto', // Default to auto permission mode for headless
        },
        authToken
      );

      const response: SendChatMessageResponse = { messageId: String(Date.now()), status: 'queued' };
      return res.json(response);
    } catch (error) {
      console.error('[API] POST /chats/:chatId/messages error:', error);
      return res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // Get chat status (headless API)
  router.get('/chats/:chatId/status', requireAuth, async (req, res) => {
    try {
      const { chatId } = req.params;
      const userEmail = req.session.userEmail!;
      const authToken = getAuthToken(req);

      console.log(`[API] GET /chats/${chatId}/status - Getting status for user ${userEmail}`);

      // Check if chat exists
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const chat = await chatService.getChat(chatIdStr, userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Check if Claude session is running
      const session = claudeCodeSessions.get(chatIdStr);
      let status: 'idle' | 'running' | 'interrupted' = 'idle';
      let lastActivity: number | undefined;

      if (session) {
        status = session.isRunning ? 'running' : 'idle';
        lastActivity = session.lastActivity;
      }

      const response: GetChatStatusResponse = { status, lastActivity };
      return res.json(response);
    } catch (error) {
      console.error('[API] GET /chats/:chatId/status error:', error);
      return res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // Slash commands + skills available to a chat (the mobile composer's `/` picker).
  // Resolves the chat's repo cwd, then returns what the SDK will actually execute
  // there (authoritative `system/init` capture, with a `.claude`-dir cold-start
  // fallback). A chat with no repo path → empty list.
  router.get('/chats/:chatId/commands', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { chatId } = req.params;
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const authToken = getAuthToken(req);

      const chat = await chatService.getChat(chatIdStr, req.session.userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const commands = await commandsService.getCommandsForChat(chat.repo_path);
      const response: GetChatCommandsResponse = { commands };
      return res.json(response);
    } catch (error) {
      console.error('[API] GET /chats/:chatId/commands error:', error);
      return res.status(500).json({ error: 'Failed to get commands' });
    }
  });

  // Summarize chat messages
  router.post('/chats/:chatId/summarize', requireAuth, async (req, res) => {
    try {
      // Check authentication
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { chatId } = req.params;
      const { sinceMessageId, maxMessages = 20 } = req.body;
      const userEmail = req.session.userEmail;

      console.log(
        `[API] POST /chats/${chatId}/summarize - Summarizing for user ${userEmail} (sinceMessageId: ${sinceMessageId})`
      );

      // Extract JWT from Authorization header for request auth
      const authToken = getAuthToken(req);

      // Check if chat exists
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const chat = await chatService.getChat(chatIdStr, userEmail, authToken);
      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Auth gate: a request must carry a JWT (requireAuth already verified it).
      if (!authToken) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'No valid authentication token found in request',
        });
      }

      // Create ChatAnalysisService instance with optional SOPService for progress tracking.
      // Local-first: summarization runs on the user's OWN Anthropic credential (LocalAiHelper).
      const chatAnalysisService = new ChatAnalysisService(localAiHelper, chatService, sopService);

      // Call summarizeRecentMessages
      const summary = await chatAnalysisService.summarizeRecentMessages(
        chatId as string,
        userEmail,
        sinceMessageId || null,
        maxMessages,
        authToken
      );

      // Return summary (or null if no new messages)
      const response: SummarizeChatResponse = { summary };
      return res.json(response);
    } catch (error: any) {
      console.error('[API] POST /chats/:chatId/summarize error:', error);
      return res.status(500).json({ error: error.message || 'Failed to summarize chat' });
    }
  });

  // Archive / unarchive a chat (the connected-menu "Archive" action).
  // Reversible: drops the chat off the active list WITHOUT deleting the shared
  // ~/.claude/projects transcript (so terminal `claude` history is untouched).
  router.post('/chats/:chatId/archive', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { chatId } = req.params;
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const archived = req.body?.archived === undefined ? true : Boolean(req.body.archived);
      const userEmail = req.session.userEmail;
      const authToken = getAuthToken(req);

      await chatService.archiveChat(chatIdStr, userEmail, archived, authToken);
      console.log(`[API] POST /chats/${chatIdStr}/archive → archived=${archived}`);
      return res.json({ success: true, chatId: chatIdStr, archived });
    } catch (error: any) {
      console.error('[API] POST /chats/:chatId/archive error:', error);
      return res.status(500).json({ error: error.message || 'Failed to archive chat' });
    }
  });

  // Save / unsave a chat (the long-press "Save" action). The "Saved" category is a
  // third bucket alongside Active/Archived — kept for later, hidden from the active
  // list, mutually exclusive with archive (saving clears archived server-side).
  router.post('/chats/:chatId/save', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { chatId } = req.params;
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const saved = req.body?.saved === undefined ? true : Boolean(req.body.saved);
      const userEmail = req.session.userEmail;
      const authToken = getAuthToken(req);

      await chatService.setChatSaved(chatIdStr, userEmail, saved, authToken);
      console.log(`[API] POST /chats/${chatIdStr}/save → saved=${saved}`);
      return res.json({ success: true, chatId: chatIdStr, saved });
    } catch (error: any) {
      console.error('[API] POST /chats/:chatId/save error:', error);
      return res.status(500).json({ error: error.message || 'Failed to save chat' });
    }
  });

  // Pin / unpin a chat (the long-press "Pin" action). Orthogonal to the category —
  // a pinned chat is highlighted and floated to the top of lists.
  router.post('/chats/:chatId/pin', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { chatId } = req.params;
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const pinned = req.body?.pinned === undefined ? true : Boolean(req.body.pinned);
      const userEmail = req.session.userEmail;
      const authToken = getAuthToken(req);

      await chatService.setChatPinned(chatIdStr, userEmail, pinned, authToken);
      console.log(`[API] POST /chats/${chatIdStr}/pin → pinned=${pinned}`);
      return res.json({ success: true, chatId: chatIdStr, pinned });
    } catch (error: any) {
      console.error('[API] POST /chats/:chatId/pin error:', error);
      return res.status(500).json({ error: error.message || 'Failed to pin chat' });
    }
  });

  // Permanently delete a chat (the long-press "Delete" action). IRREVERSIBLE — drops
  // the chat row + its portable-side messages/overlay. The shared ~/.claude/projects
  // transcript is NOT touched (terminal `claude` history is the SDK's, not ours).
  router.delete('/chats/:chatId', requireAuth, async (req, res) => {
    try {
      if (!req.session.userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const { chatId } = req.params;
      const chatIdStr = Array.isArray(chatId) ? chatId[0] : chatId;
      const userEmail = req.session.userEmail;
      const authToken = getAuthToken(req);

      await chatService.deleteChat(chatIdStr, userEmail, authToken);
      console.log(`[API] DELETE /chats/${chatIdStr}`);
      return res.json({ success: true, chatId: chatIdStr });
    } catch (error: any) {
      console.error('[API] DELETE /chats/:chatId error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete chat' });
    }
  });

  // Recent branches
  router.get('/user/recent-branches', requireAuth, async (req, res) =>
    githubApiService.handleGetRecentBranches(req, res)
  );

  // Generate project name using the local AI helper (direct Anthropic, user's own credential)
  router.post('/generate-project-name', requireAuth, async (req, res) => {
    console.log('[API] generate-project-name endpoint called');

    if (!req.session.userEmail) {
      console.log('[API] generate-project-name: Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { description, framework } = req.body;
    console.log(
      `[API] generate-project-name: description="${description?.substring(0, 50)}...", framework="${framework}"`
    );

    if (!description) {
      console.log('[API] generate-project-name: Description is missing');
      return res.status(400).json({ error: 'Description is required' });
    }

    // Slugify any text into a short kebab-case project name.
    const slugify = (text: string): string =>
      text
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);

    try {
      const prompt = `Generate a short, descriptive, kebab-case project name for this project:

Framework: ${framework || 'web app'}
Description: ${description}

Requirements:
- Use lowercase letters, numbers, and hyphens only
- Keep it short (2-4 words max)
- Make it descriptive of the project purpose
- Examples: "task-manager", "blog-platform", "chat-app"

Respond with ONLY the project name, nothing else.`;

      // Local-first: name the project with the user's OWN Anthropic credential (Haiku).
      // Fall back to a slug of the description on any failure.
      let name = slugify(description) || 'new-project';

      if (localAiHelper?.isAvailable()) {
        try {
          const generated = await localAiHelper.complete(prompt, {
            temperature: 0.3,
            maxTokens: 50,
          });
          const sanitized = slugify(generated);
          if (sanitized) {
            name = sanitized;
          }
          console.log(`[API] ✓ Generated project name: "${name}" (raw: "${generated}")`);
        } catch (aiError) {
          console.error(
            '[API] Local AI project-name generation failed, using slug fallback:',
            aiError
          );
        }
      } else {
        console.log(
          '[API] generate-project-name: No local AI credential — using slug of description'
        );
      }

      const responseData: GenerateProjectNameResponse = { name };
      res.json(responseData);
    } catch (error) {
      console.error('[API] Error generating project name:', error);
      res.status(500).json({ error: 'Failed to generate project name' });
    }
  });

  // Analyze user intent for chat/project creation
  router.post('/chats/analyze-intent', requireAuth, async (req, res) => {
    console.log('[API] analyze-intent endpoint called');

    if (!req.session.userEmail) {
      console.log('[API] analyze-intent: Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { message, pageContext } = req.body;
    console.log(`[API] analyze-intent: message="${message?.substring(0, 50)}..."`);

    if (!message) {
      console.log('[API] analyze-intent: Message is missing');
      return res.status(400).json({ error: 'Message is required' });
    }

    try {
      const analysis = await intentAnalysisService.analyzeIntent(req, message, pageContext || {});

      console.log(
        `[API] ✓ Intent analyzed: intentType=${analysis.intentType}, confidence=${analysis.confidence}`
      );
      if (analysis.suggestedFramework) {
        console.log(`[API]   Suggested framework: ${analysis.suggestedFramework}`);
      }
      if (analysis.useExistingRepo) {
        console.log(
          `[API]   Use existing repo: ${analysis.useExistingRepo.owner}/${analysis.useExistingRepo.repo}`
        );
      }

      const response: AnalyzeIntentResponse = analysis as any;
      res.json(response);
    } catch (error) {
      console.error('[API] Error analyzing intent:', error);
      res.status(500).json({ error: 'Failed to analyze intent' });
    }
  });

  // Generate contextual suggestions for user
  router.post('/chats/suggestions', requireAuth, async (req, res) => {
    console.log('[API] suggestions endpoint called');

    if (!req.session.userEmail) {
      console.log('[API] suggestions: Not authenticated');
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { message, framework, view } = req.body;

    // Validate that at least one context field is provided (before feature flag check)
    if (!message && !framework && !view) {
      console.log('[API] suggestions: No context data provided');
      return res
        .status(400)
        .json({ error: 'At least one context field (message, framework, or view) is required' });
    }

    // Check if suggestions feature is enabled
    if (!FEATURE_FLAGS.ENABLE_SUGGESTIONS) {
      console.log('[API] suggestions: Feature disabled via ENABLE_SUGGESTIONS flag');
      const response: GetSuggestionsResponse = { suggestions: [] };
      return res.json(response);
    }

    const userId = req.session.userEmail;
    console.log(
      `[API] suggestions: message="${message?.substring(0, 30) || '[empty]'}...", userId=${userId}`
    );

    try {
      const result = await suggestionsService.generateSuggestions({
        message: message || null,
        framework: framework || null,
        userId,
        view: view || 'my',
        req, // Pass request object for fetching repos
      });

      console.log(`[API] ✓ Generated ${result.suggestions.length} suggestions`);
      const response: GetSuggestionsResponse = result;
      res.json(response);
    } catch (error) {
      console.error('[API] Error generating suggestions:', error);
      res.status(500).json({ error: 'Failed to generate suggestions' });
    }
  });

  // Pending messages check (returns timestamp of latest message for a chat)
  router.get('/messages/pending/:chatId', requireAuth, async (req, res) => {
    try {
      const { chatId } = req.params;
      const authToken = getAuthToken(req);

      // Get user email from session
      const userEmail = req.session.userEmail;
      if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      // Get latest message timestamp for this chat
      const messages = await chatService.getBufferedMessages(
        userEmail,
        chatId as string,
        undefined, // since
        authToken
      );

      const latestTimestamp =
        messages.length > 0 ? Math.max(...messages.map((m: any) => m.data?.timestamp || 0)) : 0;

      res.status(200).json({
        chatId,
        latestTimestamp,
        messageCount: messages.length,
        timestamp: Date.now(),
      });
    } catch (error: any) {
      console.error('[API] Error checking pending messages:', error);
      res.status(500).json({ error: error.message || 'Failed to check messages' });
    }
  });

  // GET /api/chats/active - Returns IDs of chats with running Claude sessions (no auth, sandbox-local only)
  router.get('/chats/active', (_req, res) => {
    const activeChats = claudeService ? claudeService.getRunningChatIds() : [];
    res.json({ activeChats });
  });

  return router;
}
