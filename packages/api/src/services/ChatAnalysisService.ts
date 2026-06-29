import type { LocalAiHelper } from './ai/LocalAiHelper.js';
import type { ChatService } from './ChatService.js';
import type { SOPService } from './SOPService.js';
import type { BufferedMessage } from '@vgit2/shared/types';

// SOP Progress interface - AI-determined workflow progress
export interface SOPProgress {
  currentStep: number;
  currentStepLabel: string;
  totalApplicableSteps: number;
  completedSteps: number;
  percentageComplete: number;
}

// Throttling: Minimum time between summarizations (10 seconds)
const SUMMARIZATION_THROTTLE_MS = 10000;

/**
 * ChatAnalysisService handles AI-powered chat summarization.
 *
 * Local-first: summarization runs as a one-shot Claude (Haiku) call against the
 * user's OWN Anthropic credential via {@link LocalAiHelper}.
 * Summaries are non-critical polling, so when no local credential is available (or
 * the call fails) it degrades to `null` rather than throwing.
 * Includes throttling to prevent excessive API calls (10 second minimum between requests)
 * and caches results by message ID to avoid re-analyzing the same content.
 */
export class ChatAnalysisService {
  private localAiHelper?: LocalAiHelper;
  private chatService: ChatService;
  private sopService?: SOPService;

  // Throttling: Track last summarization time per chat
  private static lastSummarizationTime: Map<string, number> = new Map();
  // Cache: Store summaries by chat ID, keyed by latest message ID
  private static summaryCache: Map<
    string,
    {
      messageId: number;
      brief: string;
      detailed: string;
      generatedAt: number;
      sopProgress?: SOPProgress;
    }
  > = new Map();

  constructor(
    localAiHelper: LocalAiHelper | undefined,
    chatService: ChatService,
    sopService?: SOPService
  ) {
    this.localAiHelper = localAiHelper;
    this.chatService = chatService;
    this.sopService = sopService;
  }

  /**
   * Summarize recent messages in a chat (optimized for frequent polling)
   *
   * Features:
   * - Message ID-based caching: Only re-analyzes if message content changed
   * - Throttling: 10-second minimum between requests per chat
   * - Returns null if no new messages since last summarization
   * - AI-powered SOP progress analysis when worksheet exists
   *
   * @param chatId - Chat ID to summarize
   * @param userId - User ID (for RLS)
   * @param sinceMessageId - Latest message ID client has seen (optional)
   * @param maxMessages - Max messages to analyze (default: 20)
   * @param authToken - JWT token for RLS (optional)
   * @returns Summary object with optional sopProgress, or null if no new messages
   */
  async summarizeRecentMessages(
    chatId: string,
    userId: string,
    sinceMessageId: number | null,
    maxMessages: number = 20,
    authToken?: string
  ): Promise<{
    messageId: number;
    brief: string;
    detailed: string;
    generatedAt: number;
    sopProgress?: SOPProgress;
  } | null> {
    console.log(
      `[ChatAnalysisService] summarizeRecentMessages(chatId=${chatId}, sinceMessageId=${sinceMessageId})`
    );

    // 1. Check throttle (10 seconds minimum between requests)
    const now = Date.now();
    const lastTime = ChatAnalysisService.lastSummarizationTime.get(chatId);
    if (lastTime && now - lastTime < SUMMARIZATION_THROTTLE_MS) {
      const cached = ChatAnalysisService.summaryCache.get(chatId);
      if (cached) {
        console.log(
          `[ChatAnalysisService] Throttled: returning cached result (${Math.round((now - lastTime) / 1000)}s since last request)`
        );
        return cached;
      }
    }

    // 2. Local-first: summarization runs on the user's OWN Anthropic credential.
    // If none is configured, skip gracefully (this is non-critical polling).
    const aiHelper = this.localAiHelper;
    if (!aiHelper || !aiHelper.isAvailable()) {
      console.warn('[ChatAnalysisService] No local Anthropic credential — skipping summarization');
      return null;
    }

    // 3. Fetch chat info
    const chat = await this.chatService.getChat(chatId, userId, authToken);
    if (!chat) {
      throw new Error(`Chat ${chatId} not found`);
    }

    // 4. Fetch recent messages
    const messages = await this.chatService.getMessagesAfterId(
      chatId,
      0, // Get all recent messages
      maxMessages,
      authToken
    );

    console.log(`[ChatAnalysisService] Fetched ${messages.length} messages`);

    if (messages.length === 0) {
      console.log('[ChatAnalysisService] No messages to summarize');
      return null;
    }

    // 5. Get latest message ID
    const latestMessage = messages[messages.length - 1];
    const latestMessageId = latestMessage.id ? parseInt(String(latestMessage.id)) : 0;

    // 6. Check if we have cached summary for this message ID
    const cached = ChatAnalysisService.summaryCache.get(chatId);
    if (cached && cached.messageId === latestMessageId) {
      console.log(`[ChatAnalysisService] Returning cached summary for message ${latestMessageId}`);
      ChatAnalysisService.lastSummarizationTime.set(chatId, now); // Update throttle time
      return cached;
    }

    // 7. Check if there are new messages since client's last seen message
    if (sinceMessageId !== null && latestMessageId <= sinceMessageId) {
      console.log(
        `[ChatAnalysisService] No new messages since ${sinceMessageId}, skipping summarization`
      );
      return null;
    }

    // 8. Read SOP worksheet content if available
    let sopContent: string | null = null;
    if (this.sopService) {
      sopContent = await this.sopService.readWorksheetContent(chatId);
    }

    // 9. Build summary prompt
    const formattedMessages = messages
      .map((msg, idx) => {
        const role = msg.type === 'user_message' ? 'User' : 'Assistant';
        const content = this.extractMessageContent(msg);
        return `[${idx + 1}] ${role}: ${content}`;
      })
      .join('\n\n');

    const chatMetadata = `
Chat ID: ${chat.id}
Title: ${chat.title}
Repository: ${chat.repo_path || 'N/A'}
Status: ${chat.status || 'N/A'}
Total messages analyzed: ${messages.length}
    `.trim();

    // Build SOP context section if worksheet exists
    const sopSection = sopContent
      ? `
SOP WORKSHEET (Current State):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${sopContent}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyze the SOP worksheet to determine workflow progress. Consider:
- Steps marked [x] are complete
- Steps marked [IN PROGRESS] are currently active
- Steps marked [ ] are pending
- Some steps may be skipped due to decision branches (e.g., "If NO: Skip to step X")
- Calculate progress based on APPLICABLE steps only, not all steps in the SOP
`
      : '';

    // Build JSON schema based on whether SOP exists
    const jsonSchema = sopContent
      ? `{
  "detailed": "2-3 sentence summary (concise, clear, information dense)",
  "brief": "5-10 word executive summary (most important takeaways)",
  "sopProgress": {
    "currentStep": <number - the major step currently being worked on (1-9)>,
    "currentStepLabel": "<string - name of the current step, e.g., 'Implement code changes'>",
    "totalApplicableSteps": <number - total steps that apply to this workflow (excluding skipped branches)>,
    "completedSteps": <number - number of steps fully completed>,
    "percentageComplete": <number 0-100 - progress through the applicable workflow>
  }
}`
      : `{
  "detailed": "2-3 sentence summary (concise, clear, information dense)",
  "brief": "5-10 word executive summary (most important takeaways)"
}`;

    const prompt = `Analyze this chat conversation and provide a summary.

${chatMetadata}
${sopSection}
MESSAGES:
${formattedMessages}

First write a detailed 2-3 sentence summary that is concise, clear, and information dense. Then create a brief 5-10 word information dense executive summary of the most important takeaways.${sopContent ? ' Also analyze the SOP worksheet to determine workflow progress.' : ''}

Respond with ONLY valid JSON matching this schema:
${jsonSchema}`;

    // 10. Call AI via the user's OWN Anthropic credential (Haiku).
    try {
      console.log('[ChatAnalysisService] Summarizing via local Anthropic credential (Haiku)...');

      const parsed = await aiHelper.completeJson<any>(prompt, {
        temperature: 0.3, // Low temperature for consistent summaries
        maxTokens: 1024,
      });

      // 12. Build result object with optional sopProgress
      const summaryResult: {
        messageId: number;
        brief: string;
        detailed: string;
        generatedAt: number;
        sopProgress?: SOPProgress;
      } = {
        messageId: latestMessageId,
        brief: parsed.brief || 'Summary unavailable',
        detailed: parsed.detailed || 'Detailed summary unavailable',
        generatedAt: now,
      };

      // Include SOP progress if AI returned it
      if (parsed.sopProgress) {
        summaryResult.sopProgress = {
          currentStep: parsed.sopProgress.currentStep || 1,
          currentStepLabel: parsed.sopProgress.currentStepLabel || 'In progress',
          totalApplicableSteps: parsed.sopProgress.totalApplicableSteps || 9,
          completedSteps: parsed.sopProgress.completedSteps || 0,
          percentageComplete: Math.min(
            100,
            Math.max(0, parsed.sopProgress.percentageComplete || 0)
          ),
        };
      }

      // 13. Store in cache
      ChatAnalysisService.summaryCache.set(chatId, summaryResult);
      ChatAnalysisService.lastSummarizationTime.set(chatId, now);

      console.log(
        `[ChatAnalysisService] Summary cached for chat ${chatId}, message ${latestMessageId}`
      );

      return summaryResult;
    } catch (error: any) {
      // Non-critical polling — degrade to no-summary rather than 500-ing the poller.
      console.error('[ChatAnalysisService] Summarization failed, returning no summary:', error);
      return null;
    }
  }

  /**
   * Extract text content from a message
   */
  private extractMessageContent(msg: BufferedMessage): string {
    if (!msg.data) return '[empty message]';

    // Handle different message formats
    if (typeof msg.data === 'string') {
      return msg.data;
    }

    if (typeof msg.data === 'object') {
      // Extract from content field
      if ('content' in msg.data) {
        const content = (msg.data as any).content;

        if (typeof content === 'string') {
          return content;
        }

        if (Array.isArray(content)) {
          // Extract text from content blocks
          return content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join(' ');
        }
      }

      // Fallback: stringify the data
      return JSON.stringify(msg.data);
    }

    return '[unsupported message format]';
  }
}
