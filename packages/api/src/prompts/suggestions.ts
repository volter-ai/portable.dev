/**
 * Task Suggestions Prompts
 *
 * Prompts used for generating context-aware task suggestions in autocomplete mode.
 * Prioritizes recent tasks from GitHub (issues/PRs) and enriches with metadata.
 */

/**
 * Builds the suggestions prompt for task autocomplete
 *
 * @param params - Parameters including message, repos, tasks, framework
 * @param taskMetadata - Metadata map with issue numbers and repo info
 * @returns Formatted prompt for Gemini API
 */
export function buildSuggestionsPrompt(
  params: {
    message?: string | null;
    repos: string[];
    tasks: string[];
    framework?: string | null;
  },
  taskMetadata: Map<
    string,
    { issueNumber: number; repoOwner: string; repoName: string; ownerAvatarUrl: string }
  >
): string {
  const { message, repos, tasks, framework } = params;

  // Build task list with repo and issue number context from metadata
  const tasksWithContext = tasks
    .slice(0, 10)
    .map((taskTitle, i) => {
      const metadata = taskMetadata.get(taskTitle);
      if (metadata && metadata.repoOwner && metadata.repoName) {
        return `${i + 1}. "${taskTitle}" (repo: ${metadata.repoOwner}/${metadata.repoName}, issue #${metadata.issueNumber})`;
      }
      return `${i + 1}. "${taskTitle}"`;
    })
    .join(', ');

  return `You are a helpful AI assistant suggesting concrete, actionable tasks for a developer.

Context:
- Current input: "${message || '[empty]'}"
- Recent repositories (sorted by recency): ${
    repos.length > 0
      ? repos
          .slice(0, 10)
          .map((r, i) => `${i + 1}. ${r}`)
          .join(', ')
      : 'None'
  }
- Recent tasks/issues (sorted by most recently updated first): ${tasks.length > 0 ? tasksWithContext : 'None'}
- Selected framework: ${framework || 'none'}

Generate 3 CONCRETE, SPECIFIC suggestions for what the developer might want to do.

CRITICAL RULES:
1. **PRIORITIZE TASKS FIRST** - If there are tasks in the context, base suggestions on them
2. **USE TASK REPO INFO** - When a task includes "(repo: owner/repo, issue #123)", ALWAYS include that repo in your suggestion
3. **MIX REPO-SPECIFIC AND GENERAL** - Most suggestions should be repo-specific when repos exist, but general tasks are allowed
4. **AUTOCOMPLETE MODE** - The "completion" should complete/extend the user's input intelligently, making it more specific and actionable
5. **BE SPECIFIC** - Use exact repo names from the task context
6. **BE ACTIONABLE** - Each suggestion should be something they can immediately work on
7. **STRUCTURE REPO DATA** - Parse "owner/repo" from task context into separate owner and name fields
8. **KEEP NAMES ULTRA SHORT** - The "name" field MUST be 2-4 words maximum, single line only (e.g., "Fix profile bug", "Add dark mode", "Stream thumbnails")
9. **INCLUDE ISSUE NUMBERS** - If a task has "(issue #123)", set issueNumber to 123 in your response

SUGGESTION TYPES:
- **Repo-specific**: Tasks tied to a specific repository (include repo field with owner and name)
- **General**: Documentation, learning, planning, architecture (set repo to null)

AUTOCOMPLETE LOGIC:
- If input is empty: provide 3 full task-based suggestions from recent tasks (or repo-based if no tasks)
- If input has text: complete/extend it in 3 different directions based on tasks/repos
- Format: user's input + your completion = full actionable task
- The completion should be grammatically correct when appended to the input

GOOD EXAMPLES:

Example 1:
Input: ""
Tasks: 1. "Add user authentication" (repo: vgit2/portable, issue #42), 2. "Fix profile page bug" (repo: user/dashboard, issue #15), 3. "Write API docs"
Repos: ["vgit2/portable", "user/dashboard"]
→ Suggestions:
{
  "suggestions": [
    {
      "name": "Add user auth",
      "completion": "Add user authentication with email/password to vgit2/portable",
      "repo": { "owner": "vgit2", "name": "portable" },
      "taskReference": "Add user authentication",
      "issueNumber": 42
    },
    {
      "name": "Fix profile bug",
      "completion": "Fix the profile page rendering bug in user/dashboard",
      "repo": { "owner": "user", "name": "dashboard" },
      "taskReference": "Fix profile page bug",
      "issueNumber": 15
    },
    {
      "name": "Write API docs",
      "completion": "Write comprehensive API documentation for REST endpoints",
      "repo": null,
      "taskReference": "Write API docs",
      "issueNumber": null
    }
  ]
}

Example 2:
Input: "fix the"
Tasks: 1. "Fix profile page bug" (repo: user/dashboard, issue #78), 2. "Fix API rate limiting" (repo: company/api-service, issue #91)
Repos: ["user/dashboard", "company/api-service"]
→ Suggestions:
{
  "suggestions": [
    {
      "name": "Profile bug",
      "completion": " profile page rendering bug in user/dashboard",
      "repo": { "owner": "user", "name": "dashboard" },
      "taskReference": "Fix profile page bug",
      "issueNumber": 78
    },
    {
      "name": "API timeout",
      "completion": " API rate limiting issue in company/api-service",
      "repo": { "owner": "company", "name": "api-service" },
      "taskReference": "Fix API rate limiting",
      "issueNumber": 91
    },
    {
      "name": "Error handling",
      "completion": " error handling to provide better user feedback",
      "repo": null,
      "taskReference": null,
      "issueNumber": null
    }
  ]
}

Example 3:
Input: "add"
Tasks: 1. "Add dark mode" (repo: vgit2/portable, issue #123)
Repos: ["vgit2/portable"]
→ Suggestions:
{
  "suggestions": [
    {
      "name": "Dark mode",
      "completion": " a dark mode toggle in vgit2/portable settings panel",
      "repo": { "owner": "vgit2", "name": "portable" },
      "taskReference": "Add dark mode",
      "issueNumber": 123
    },
    {
      "name": "Loading state",
      "completion": " loading spinner to vgit2/portable API requests",
      "repo": { "owner": "vgit2", "name": "portable" },
      "taskReference": null,
      "issueNumber": null
    },
    {
      "name": "Test coverage",
      "completion": " comprehensive test suite for critical user flows",
      "repo": null,
      "taskReference": null,
      "issueNumber": null
    }
  ]
}

PRIORITY ORDER:
1. If tasks exist → derive most suggestions from tasks (2-3 from tasks, 0-1 general), prioritizing the most recently updated tasks
2. If no tasks but repos exist → suggest concrete work for those repos
3. If neither → suggest general development tasks (learning, setup, planning)

Return ONLY valid JSON without any markdown or explanation:
{
  "suggestions": [
    {
      "name": "2-4 word label (e.g., 'Fix profile bug', 'Add user auth')",
      "completion": "The text that completes the user's input (autocomplete style)",
      "repo": { "owner": "repo-owner", "name": "repo-name" } | null,
      "taskReference": "Task description or ID this relates to" | null,
      "issueNumber": number | null (GitHub issue/PR number if available, backend will enrich this automatically)
    },
    ...
  ]
}`;
}
