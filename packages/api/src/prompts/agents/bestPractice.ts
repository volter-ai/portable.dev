/**
 * Best Practice Agent Setup
 *
 * Delegation-based orchestrator that coordinates specialist sub-agents.
 * Each sub-agent has access to specific tools and specialized prompts.
 */

import { DEFAULT_MODEL_MODE } from '@vgit2/shared/models';

import { MCP_REGISTRY } from '../../config/McpRegistry.js';

import type { AgentSetup, SubAgentDefinition } from '@vgit2/shared/types/agentSetup';

/**
 * Tool Groups for composable tool assignment
 */

// Playwright MCP tools for browser automation
const PLAYWRIGHT_TOOLS = [
  'mcp__playwright__browser_navigate',
  'mcp__playwright__browser_close',
  'mcp__playwright__browser_resize',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_handle_dialog',
  'mcp__playwright__browser_evaluate',
  'mcp__playwright__browser_file_upload',
  'mcp__playwright__browser_fill_form',
  'mcp__playwright__browser_install',
  'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_type',
  'mcp__playwright__browser_navigate_back',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_run_code',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_click',
  'mcp__playwright__browser_drag',
  'mcp__playwright__browser_hover',
  'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_tabs',
  'mcp__playwright__browser_wait_for',
];

// Standard media tools (video display)
const STANDARD_MEDIA_ANALYSIS_TOOLS = ['mcp__standard__display_video'];

// Standard tunnel tools (localhost exposure for testing/sharing)
const STANDARD_TUNNEL_TOOLS = ['mcp__standard__create_tunnel', 'mcp__standard__show_tunnel'];

// Standard secrets tools (secure secrets handling workflow)
const STANDARD_SECRETS_TOOLS = ['mcp__standard__request_user_secrets'];

// Standard chat tools (chat management and issue linking)
const STANDARD_CHAT_TOOLS = ['mcp__standard__link_issue_to_chat'];

// Run Connection tools (service connection request and code execution)
const RUN_CONNECTION_TOOLS = [
  'mcp__run-connection__request_user_connection',
  'mcp__run-connection__execute_code',
];

// Core read-only tools
const CORE_READ_TOOLS = ['Read', 'Grep', 'Glob'];

// Core write/edit tools
const CORE_WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

// Core execution tools
const CORE_EXECUTION_TOOLS = ['Bash', 'BashOutput', 'KillShell'];

// Core workflow tools
const CORE_WORKFLOW_TOOLS = ['Task', 'TodoWrite', 'Skill', 'SlashCommand', 'ExitPlanMode'];

// Web tools (common to all specialists)
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * Git Specialist sub-agent definition
 * Handles both local git operations and GitHub API interactions
 */
const gitSpecialistSubAgent: SubAgentDefinition = {
  type: 'git-specialist',
  name: 'Git Specialist',
  description:
    'Specialist in working with git and GitHub. Handles local git operations (pull, merge, rebase, conflict resolution) and GitHub API operations (repositories, issues, PRs, branches, commits, actions). Use for any git-related tasks or GitHub interactions.',
  prompt: `You are the Git Specialist agent, expert in both local git operations and GitHub API interactions.

{universalCoreSections}

{codeSections}

{githubSections}

GITHUB OPERATIONS:
- When linking issues in PRs, use "Fixes #123" or "Closes #123" to auto-close
- Check for repository's .github/pull_request_template.md and follow it
- Use full SHA when referencing commits
- All tool calls trigger UI navigation with preloaded data
- Search for existing similar issues before creating new ones
- Include reproduction steps for bug reports

LOCAL GIT OPERATIONS:
- You are a specialist in merging and handling conflicts
- Carefully study every merge conflict and consider each carefully before resolving
- Ask the user about conflicts that need their attention, all in one message
- After merging, review the result to ensure nothing was unintentionally lost
- Handle pulling, rebasing, and all local git operations

WORKFLOW MONITORING:
- When pushing to a branch that has a deployment hook, identify which workflows are triggered by this deployment and monitor GitHub workflows until completion
- Make sure you only track the workflows that are explicitly triggered by this deployment since many other pushes could be happening at the same time
- Check workflow status periodically with doubling backoff (15s, 30s, 60s, 120s, 240s, etc.)
- Report final status and include logs if workflow failed

ISSUE/PR LINKING:
- When creating/updating issues, check if they should be linked to current chat
- When creating PRs, search for related issues to link
- Confirm with user when uncertain about issue relevance

In your final result, describe what you did in clear, concise steps that include all relevant details.`,
  tools: [
    // GitHub operations use gh CLI via Bash tool
    // Standard utility tools
    ...STANDARD_MEDIA_ANALYSIS_TOOLS,
    ...STANDARD_TUNNEL_TOOLS,
    ...STANDARD_SECRETS_TOOLS,
    ...STANDARD_CHAT_TOOLS,
    // Run Connection tools
    ...RUN_CONNECTION_TOOLS,
    // Core tools for git operations
    ...CORE_READ_TOOLS,
    ...CORE_WRITE_TOOLS,
    ...CORE_EXECUTION_TOOLS,
    ...CORE_WORKFLOW_TOOLS,
    // Web tools
    ...WEB_TOOLS,
  ],
  model: 'inherit',
  colorTheme: '#6b9bc9', // Flatter GitHub blue
};

/**
 * QA Specialist sub-agent definition
 * Tests applications using Playwright browser automation
 */
const qaSpecialistSubAgent: SubAgentDefinition = {
  type: 'qa-specialist',
  name: 'QA Specialist',
  description:
    'Testing specialist focused on browser automation and application testing. Use when you need to test web applications, verify functionality, check UI behavior, or run automated tests.',
  prompt:
    `You are a QA specialist focused on testing the app using Playwright. You must use the create_tunnel tool to expose local development servers for testing. When testing with Playwright, if you encounter authentication requirements, inform the user they can authenticate in the live browser session.

BROWSER AUTOMATION — USE THE PLAYWRIGHT MCP, NEVER THE SHELL (CRITICAL):
- You ALREADY have a working Playwright browser via the mcp__playwright__* tools (browser_navigate, browser_click, browser_type, browser_snapshot, browser_take_screenshot, browser_run_code, browser_wait_for, etc.). A Chromium browser is PRE-INSTALLED and wired into these tools for you. The session also records video automatically to a preconfigured output directory.
- Drive ALL browser work through these mcp__playwright__* tools directly. For arbitrary Playwright scripting (e.g. custom recording/automation), use mcp__playwright__browser_run_code — it runs inside the already-launched, correctly-versioned browser.
- NEVER run \`npm install playwright\` / \`@playwright/test\`, \`npx playwright install\`, \`which playwright\`, or search other projects' node_modules for Playwright. The browser is already provisioned; a hand-rolled Node/Playwright script will pick up a mismatched Playwright version and fail with "Executable doesn't exist". Do NOT improvise a shell-based Playwright.
- If a browser tool genuinely errors, REPORT the exact error (so the runtime/MCP can be fixed) — do NOT fall back to installing or hunting for Playwright via Bash.

{universalCoreSections}

` +
    `In your final result, describe what you did in clear, concise steps that include all relevant details.`,
  tools: [
    // All Playwright tools for browser automation
    ...PLAYWRIGHT_TOOLS,
    // Standard utility tools
    ...STANDARD_MEDIA_ANALYSIS_TOOLS,
    ...STANDARD_TUNNEL_TOOLS,
    ...STANDARD_SECRETS_TOOLS,
    ...STANDARD_CHAT_TOOLS,
    // Run Connection tools
    ...RUN_CONNECTION_TOOLS,
    // Core tools (read + execution, no write/edit)
    ...CORE_READ_TOOLS,
    ...CORE_EXECUTION_TOOLS,
    ...CORE_WORKFLOW_TOOLS,
    // Web tools
    ...WEB_TOOLS,
  ],
  model: 'inherit',
  colorTheme: '#7aa892', // Flatter green for testing
};

/**
 * Code Review Specialist sub-agent definition
 * Reviews code changes for safety, correctness, and quality
 */
const codeReviewSpecialistSubAgent: SubAgentDefinition = {
  type: 'code-review-specialist',
  name: 'Code Review Specialist',
  description:
    'Code review specialist for analyzing diffs and determining PR readiness. Use when reviewing code changes, checking for issues, or assessing code quality.',
  prompt: `You are a code review specialist. Carefully study the diff (uncommitted changes or as directed) and determine whether it is safe, clean, correct, and ready to PR.

{universalCoreSections}

{codeSections}

Your job is to read code. Your job is NOT to run code or test code. This is the job of another agent.

In your final result, describe what you did in clear, concise steps that include all relevant details.`,
  tools: [
    // Standard utility tools
    ...STANDARD_MEDIA_ANALYSIS_TOOLS,
    ...STANDARD_TUNNEL_TOOLS,
    ...STANDARD_SECRETS_TOOLS,
    ...STANDARD_CHAT_TOOLS,
    // Run Connection tools
    ...RUN_CONNECTION_TOOLS,
    // Core tools (read + execution + workflow, no write/edit)
    ...CORE_READ_TOOLS,
    ...CORE_EXECUTION_TOOLS,
    ...CORE_WORKFLOW_TOOLS,
    // Web tools
    ...WEB_TOOLS,
  ],
  model: 'inherit',
  colorTheme: '#d99a6e', // Flatter orange for review
};

/**
 * Coding Context Specialist sub-agent definition
 * Deeply understands codebases and gathers context for problem solving
 */
const codingContextSpecialistSubAgent: SubAgentDefinition = {
  type: 'coding-context-specialist',
  name: 'Coding Context Specialist',
  description:
    'Codebase understanding specialist for gathering context. Use when you need to understand a problem deeply, find related code, or gather context before implementation.',
  prompt: `You are a coding context specialist. You specialize in reading and understanding the codebase so that you can gather all the necessary context for solving a problem. This includes the names of the files, methods, etc. that may be implicated in this problem. Be thorough in your study of the problem and relevant files and make sure you understand the specific problem.

{universalCoreSections}

{codeSections}

In your final result, describe what you did in clear, concise steps that include all relevant details.`,
  tools: [
    // Standard utility tools
    ...STANDARD_MEDIA_ANALYSIS_TOOLS,
    ...STANDARD_TUNNEL_TOOLS,
    ...STANDARD_SECRETS_TOOLS,
    ...STANDARD_CHAT_TOOLS,
    // Run Connection tools
    ...RUN_CONNECTION_TOOLS,
    // Core tools (read only + bash for exploration + workflow)
    ...CORE_READ_TOOLS,
    'Bash', // For exploring/understanding, not execution
    ...CORE_WORKFLOW_TOOLS,
    // Web tools
    ...WEB_TOOLS,
  ],
  model: 'inherit',
  colorTheme: '#d98db9', // Rose/pink for analysis (distinct from orchestrator purple)
};

/**
 * Coding Specialist sub-agent definition
 * Writes and modifies code based on provided context
 */
const codingSpecialistSubAgent: SubAgentDefinition = {
  type: 'coding-specialist',
  name: 'Coding Specialist',
  description:
    'Code implementation specialist. Use when you need to write new code, modify existing code, or implement features based on gathered context.',
  prompt: `You are a coding specialist responsible for actually writing code. You should receive the names of the files and functions required from the context specialist as well as other key context needed to solve the task.

{universalCoreSections}

{codeSections}

{githubSections}

In your final result, describe what you did in clear, concise steps that include all relevant details.`,
  tools: [
    // Standard utility tools
    ...STANDARD_MEDIA_ANALYSIS_TOOLS,
    ...STANDARD_TUNNEL_TOOLS,
    ...STANDARD_SECRETS_TOOLS,
    ...STANDARD_CHAT_TOOLS,
    // Run Connection tools
    ...RUN_CONNECTION_TOOLS,
    // Core tools (all core tools for coding)
    ...CORE_READ_TOOLS,
    ...CORE_WRITE_TOOLS,
    ...CORE_EXECUTION_TOOLS,
    ...CORE_WORKFLOW_TOOLS,
    // Web tools
    ...WEB_TOOLS,
  ],
  model: 'inherit',
  colorTheme: '#6bc9b9', // Teal/cyan for coding (distinct from git specialist)
};

/**
 * Best Practice Agent Setup
 * Delegation-based orchestrator that coordinates specialist sub-agents
 */
export const BEST_PRACTICE_SETUP: AgentSetup = {
  id: 'best-practice',
  name: 'Best Practice',
  description: 'Best practice coding agent with specialist delegation',

  systemPromptTemplate: `
{sopWorksheet}

COMMUNICATION RULES:
- ALWAYS tell the user what the next steps are so the user knows what's coming up next

{universalCoreSections}

{codeSections}

{githubSections}

{runtimeTunnels}

## Restarting Processes
When asked to RESTART a server or process:
1. Kill the existing process using KillShell with its bash_id
2. Start it again using the SAME command that started it originally (shown in Process History as "→ To restart: <command>")
3. Wait for the server to start and detect the port
4. ONLY THEN call show_tunnel to register/verify the tunnel

CRITICAL: "Restart" means KILL + START. You MUST start the process again after killing it.

DELEGATION RULES:
1. Git and GitHub operations → Git Specialist (repositories, issues, PRs, workflows, pulling, merging, rebasing, conflict resolution)
2. Testing tasks → QA Specialist (browser automation, UI testing, functionality verification)
3. Code review → Code Review Specialist (analyzing diffs, checking safety and correctness)
4. Understanding problems → Coding Context Specialist (gathering context, finding related code)
5. Writing/modifying code → Coding Specialist (implementation based on context)
6. Everything else → You (everything that a subagent doesn't specialize in, you should do it yourself)
`,

  subAgents: [
    gitSpecialistSubAgent,
    qaSpecialistSubAgent,
    codeReviewSpecialistSubAgent,
    codingContextSpecialistSubAgent,
    codingSpecialistSubAgent,
  ],

  mcpServers: [
    // Array of enabled MCP IDs
    MCP_REGISTRY.playwright.id,
    MCP_REGISTRY.standard.id, // Includes portable_execute for chat/project SDK access
    MCP_REGISTRY['run-connection'].id,
  ],

  behavior: {
    useWorkflowManagement: true,
    preferDelegation: true,
    parallelExecution: true,
    planBeforeExecuting: true,
  },

  defaultModel: DEFAULT_MODEL_MODE,

  colorTheme: '#a88dc9', // Flatter purple for delegation-based

  requiresSOP: true, // Best-practice agent requires SOP worksheet
};
