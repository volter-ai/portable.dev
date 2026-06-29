/**
 * Chat Search Prompts
 *
 * Prompts used for semantic chat search using AI to rank relevance.
 * Considers title, summary, repository context, and semantic meaning.
 */

/**
 * Builds the search prompt for semantic chat ranking
 *
 * @param query - User's search query
 * @param formattedChats - Formatted string of chats to search
 * @param limit - Maximum number of results to return
 * @returns Formatted prompt for Gemini API
 */
export function buildChatSearchPrompt(
  query: string,
  formattedChats: string,
  limit: number
): string {
  return `You are a semantic search engine. Find and rank chats relevant to the user's query.

USER QUERY: "${query}"

CHATS TO SEARCH:
${formattedChats}

Analyze which chats are relevant to the query. Consider:
- Title relevance
- Summary content
- Repository context
- Semantic meaning (not just keyword matching)

Respond with ONLY valid JSON matching this schema:
{
  "matches": [
    {
      "index": 0,
      "chatId": "chat-xxx",
      "relevanceScore": 0.95,
      "reason": "Brief explanation of why this is relevant"
    }
  ]
}

Return top ${Math.min(limit || 10, 50)} results sorted by relevance (highest first).
If no chats are relevant, return empty matches array.`;
}
