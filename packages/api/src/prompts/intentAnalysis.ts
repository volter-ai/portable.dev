/**
 * Intent Analysis Prompts
 *
 * Prompts used for analyzing user intent to determine task type:
 * - simple-task: Questions, brainstorming, AI models
 * - new-repo: Creating new code projects
 * - existing-repo: Working on existing repositories
 */

/**
 * Builds the analysis prompt for intent classification
 *
 * @param message - User's message to analyze
 * @param existingRepos - List of user's existing repository names
 * @param pageContext - Current page context (optional)
 * @returns Formatted prompt for Gemini API
 */
export function buildAnalysisPrompt(
  message: string,
  existingRepos: string[],
  pageContext: any
): string {
  return `Analyze this user message to determine their intent. Think step-by-step about what the user wants.

User message: "${message}"
${existingRepos.length > 0 ? `User's existing repositories: ${existingRepos.join(', ')}` : 'No existing repositories'}
${pageContext.type ? `Current page context: ${JSON.stringify(pageContext)}` : ''}

CRITICAL: You must categorize the request into EXACTLY ONE of these three types:

1. "simple-task": Questions, brainstorming, running AI models, or information lookup
   - Examples: "how does X work?", "explain Y", "generate an image", "use nanobanana to redesign this", "what time is it?", "help me understand Z"
   - When users mention tools like "nanobanana", "flux", "sora" they usually mean AI models, NOT code frameworks
   - This is for tasks that don't involve creating or modifying code repositories

2. "new-repo": User wants to CREATE a brand new code project/application from scratch
   - Examples: "create a todo app", "build a website", "make a game", "setup a new React project", "start a blog"
   - Must be clearly about CREATING NEW code, not working on existing code
   - User is asking for a new GitHub repository to be created

3. "existing-repo": User wants to work on an EXISTING repository they already have
   - Check if message mentions any repo names from their list
   - Look for: "my app", "the project", "fix my code", "debug", "add feature to"
   - Match partial names (e.g., "my blog" might mean "my-blog-site" repo)
   - If user has a file open in their IDE, they likely mean that repo

Framework selection (ONLY for "new-repo" type):
   - DEFAULT TO "bun" unless user explicitly mentions another framework
   - NEVER select "vite" unless user explicitly says "vite" or "Vite"
   - bun: Default for most projects (fast, modern, TypeScript-first)
   - next: Only if user mentions "Next.js" or needs SSR/SSG
   - express: Only if user mentions "Express" or "API server"
   - empty: Only for vanilla HTML/CSS/JS projects
   - null: For "simple-task" and "existing-repo" types (use null, not undefined)

ALWAYS suggest a folder name:
   - Use kebab-case (my-cool-app not MyCoolApp)
   - Keep it short and descriptive
   - For simple-task: base on topic (e.g., "image-redesign", "ai-generation", "question-123")
   - For new-repo: base on project (e.g., "todo-app", "blog-site")
   - For existing-repo: can use existing repo name

Return ONLY valid JSON without any markdown or explanation:
{
  "reasoning": "First explain your thinking about what the user wants",
  "intentType": "simple-task" | "new-repo" | "existing-repo",
  "suggestedName": "always-provide-a-name",
  "suggestedFramework": "bun" | "next" | "express" | "empty" | null,
  "useExistingRepo": { "owner": "user", "repo": "repo-name" } | null,
  "confidence": 0.0 to 1.0
}`;
}
