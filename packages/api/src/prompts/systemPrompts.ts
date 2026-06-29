import * as fs from 'fs';
import * as path from 'path';

import { getAIStylePrompt, type AIStyleMode } from '@vgit2/shared/aiStyles';
import * as constants from '@vgit2/shared/constants';

import { getAgentSetup } from '../config/agentRegistry.js';

import type { AgentSetup } from '@vgit2/shared/types';

// Helper function to inject CLAUDE.md content if it exists
function getClaudeMdContent(repoPath: string): string {
  try {
    const claudeMdPath = path.join(repoPath, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(CLAUDE.md):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${content}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
END OF CLAUDE.md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEGINNING SYSTEM RULES. THE FOLLOWING RULES MUST BE FOLLOWED STRICTLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    }
    // No CLAUDE.md found - warn the user and offer to create one
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  WARNING: NO CLAUDE.md FOUND IN THIS REPOSITORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This repository does not have a CLAUDE.md file with project-specific rules.

IMPORTANT: When the user asks you to do ANYTHING substantive in this repo:
1. First warn them: "This repository doesn't have a CLAUDE.md file with project rules."
2. Offer to create one: "Would you like me to create a CLAUDE.md file with coding standards and project conventions?"
3. If they agree, create a comprehensive CLAUDE.md based on:
   - Existing code patterns in the repository
   - Framework conventions (if applicable)
   - Common best practices
   - Any patterns you observe in the codebase

Without CLAUDE.md, you may not follow project-specific conventions correctly.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
  } catch (error) {
    return '';
  }
}

/**
 * Universal Core Sections - ALL agents need these
 * These are tool-independent fundamental rules
 */
function getUniversalCoreSections() {
  return {
    completion: `
COMPLETION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You MUST do exactly one of:
1. Output <promise>COMPLETE</promise> on its own line if ALL tasks are done and you have nothing left to do
2. Ask the user a specific question about next steps
Do not do both. NEVER use natural language to signal completion ("I'm done", "All finished", "Ready when you wake up"). ONLY the exact token <promise>COMPLETE</promise> signals to auto-pilot that the task is complete.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,

    processManagement: `
CRITICAL - PROCESS MANAGEMENT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 FORBIDDEN: pkill, killall, or any command that kills processes by name
   These will crash everything (you're running inside a Bun process)

✅ CORRECT: Use KillShell tool with bash_id to stop specific processes you started
   All your background processes get unique bash_ids for safe termination
   If you need to kill a process you didn't start, you must surgically kill only that process and you may not kill reserved ports to the system server (65534, 65535, 7878)

Protected system processes:
- System Server Backend (port 65534) and Frontend (port 65535)
- Parent processes that started your session
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,

    portConflicts: `
PORT CONFLICTS:
When a process you're starting has a port conflict:
1. Check if port is 65534 or 65535 (NEVER kill these - these are vital system ports)
2. Check if YOU started the process in this chat (don't kill your own processes)
3. If neither → kill ONLY that specific process to free the port
   Example: lsof -ti :3000 | xargs kill -9  (surgical removal)
This cleans up orphaned processes from previous sessions.`,

    workspace: `
IMPORTANT - WORKING DIRECTORY:
- Current working directory is already set to the repository path
- Use relative paths (./src/file.ts) or pwd/cwd commands
- DO NOT assume paths like /data/workspaces/ - use the working directory as-is
- The workspace root is /workspace in this container`,

    secrets: `
IMPORTANT: If you need secrets (API keys, tokens, passwords):
- FIRST: Use Read tool to check if .env (or other secrets file) exists and what secrets are already present
- THEN: Use request_user_secrets tool ONLY for secrets that are actually missing
- The tool will surface a special UI that allows the user to add or edit the secrets
- Never ask the user to paste secrets in chat, that is not secure
- When the user finishes adding secrets, you will receive a message telling you that the secrets have been updated. At that time you should confirm that secrets have been updated correctly`,

    richComponents: `
RICH UI COMPONENTS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You can embed rich UI components in your text responses using JSX-like syntax.
These render as interactive, clickable cards that navigate to the relevant pages.

AVAILABLE COMPONENTS:

1. GitHubIssue - Clickable issue card (green icon)
   <GitHubIssue repo="owner/repo" number={123} />
   Props: repo (required), number (required), compact (optional)

2. GitHubPR - Clickable pull request card (blue icon)
   <GitHubPR repo="owner/repo" number={456} />
   Props: repo (required), number (required), compact (optional)

3. GitHubWorkflow - Clickable workflow run card (orange icon)
   <GitHubWorkflow repo="owner/repo" runId={789} />
   Props: repo (required), runId (required), compact (optional)

SYNTAX RULES:
- Components must be self-closing: <Component ... />
- String props use quotes: repo="owner/repo"
- Number props use braces: number={123}
- Boolean shorthand: compact (same as compact={true})

WHEN TO USE:
- When referencing GitHub issues, PRs, or workflow runs
- Makes your responses interactive - users can click to navigate
- Use compact={true} for inline references within sentences
- Regular markdown still works for all other formatting

EXAMPLES:
"The bug is tracked in <GitHubIssue repo="vercel/next.js" number={12345} />"

"I created a PR to fix this: <GitHubPR repo="owner/repo" number={42} />"

"The deployment is running: <GitHubWorkflow repo="owner/repo" runId={9876543} />"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  };
}

/**
 * GitHub Sections - Only for agents working with GitHub
 * Instructions for GitHub operations (issues, PRs, repos, etc.)
 */
function getGitHubSections() {
  return {
    githubIntegration: '', // GitHub operations use gh CLI exclusively
  };
}

/**
 * Code Sections - Only for agents working with code
 * Instructions for code-related work (search, analysis, implementation, etc.)
 */
function getCodeSections() {
  return {
    codeAnalysis: `
CODE ANALYSIS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You have access to **ast-grep**, a powerful AST-based code search tool that understands code structure, not just text patterns.

WHEN TO USE AST-GREP VS GREP:

Use ast-grep when:
• Finding function/class/variable definitions with full context
• Searching by code structure (e.g., "all functions that call X")
• Finding imports, exports, or dependencies
• Analyzing code patterns (e.g., "all React components with useState")
• Language-aware searching (respects syntax, not just text)

Use Grep when:
• Simple text/string searches
• Searching non-code files (logs, markdown, config files)
• Regex pattern matching across any file type
• Quick searches where structure doesn't matter
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  };
}

/**
 * Tool-Specific Sections - Only included when agent has specific tools
 * These are conditional based on the agent's tool configuration
 */
function getToolSpecificSections() {
  return {
    browserAutomation: `
BROWSER AUTOMATION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ USE: mcp__playwright__browser_* tools (local Chromium, ready to use)
❌ DON'T: Run local Playwright/Puppeteer scripts or install browsers
❌ NEVER call mcp__playwright__browser_close - keep the session open for the user
🔧 Keep dev servers and tunnels running after testing for user access

IMPORTANT: AUTHENTICATION DURING BROWSER AUTOMATION:
If you encounter a login page and login is required, you MUST offer the user the ability to login. Otherwise, DO NOT consider the task to be complete:
• OAuth, 2FA, and CAPTCHAs require manual user intervention
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,

    viteProjectHandling: (() => {
      // Local-first runtime uses Cloudflare Quick Tunnels for dev-server access
      const allowedHost = '.trycloudflare.com';

      return `
VITE PROJECTS - SPECIAL TUNNEL HANDLING:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Vite has strict allowed hosts checking. You MUST configure Vite BEFORE starting it.

CORRECT WORKFLOW FOR VITE:
1. Determine the port (default 5173, check vite.config for custom)
2. Create tunnel FIRST using create_tunnel tool
3. Update vite.config.ts to add:
   server: {
     host: true,
     allowedHosts: ['${allowedHost}']
   }
4. Then start Vite (bun dev or bun run dev)
5. Wait for server ready message

❌ Starting Vite first = tunnel URL won't be allowed, connection rejected
✅ Tunnel first, config second, start third = everything works
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    })(),
  };
}

/**
 * Legacy function for backward compatibility
 * Combines all sections for agents that use {coreSections} placeholder
 * @deprecated Use getUniversalCoreSections, getGitHubSections, getCodeSections, and getToolSpecificSections instead
 */
function getCoreSystemSections() {
  return {
    ...getUniversalCoreSections(),
    ...getGitHubSections(),
    ...getCodeSections(),
    ...getToolSpecificSections(),
  };
}

// Export the new modular functions
export { getUniversalCoreSections, getGitHubSections, getCodeSections, getToolSpecificSections };

/**
 * Build runtime tunnel section for system prompt
 * Generates tunnel information based on tunnel service state
 *
 * **Note**: Exported for testing purposes only. Production code should use
 * buildSystemPromptFromSetup() which calls this internally with runtime values.
 *
 * @param tunnelService - TunnelService instance to retrieve active tunnels
 * @param userId - Optional user ID to filter tunnels
 * @returns Formatted tunnel section string, or empty string if no tunnels exist
 */
export function buildRuntimeTunnelSection(tunnelService: any, userId: string | undefined): string {
  const tunnelMappings = tunnelService.getTunnelMappings(userId);
  if (!tunnelMappings || tunnelMappings.length === 0) return ''; // No tunnels exist

  const tunnelList = tunnelMappings
    .map((t: { port: number; url: string }) => `  localhost:${t.port} → ${t.url}`)
    .join('\n');

  // Temporary/dynamic Cloudflare Quick Tunnels (any port, short lifetime)
  return `

IMPORTANT - TEMPORARY TUNNELS FOR LOCALHOST ACCESS:
Temporary HTTPS tunnels available for any port.

Current tunnels:
${tunnelList}

CRITICAL INSTRUCTIONS FOR TUNNELS:
1. These are temporary HTTPS tunnels (15-minute lifetime)
2. They make a local dev server publicly reachable (e.g. for the mobile in-chat preview)
3. Use create_tunnel to create new tunnels for any port

WHEN TO USE create_tunnel TOOL:
- Call create_tunnel(port=XXXX) after starting any dev server
- Tunnels can be created for any port (1024-65535)
- Tunnels expire after 15 minutes of inactivity`;
}

// Build system prompt from agent setup
export function buildSystemPromptFromSetup(
  agentSetupId: string,
  context: {
    repoPath?: string;
    owner?: string;
    repo?: string;
    localReposList?: string;
    pageContext?: any;
    runtimeState?: string;
    permissionMode?: string;
    aiStyle?: AIStyleMode;
    customAiStylePrompt?: string;
    username?: string;
    userEmail?: string;
    userId?: string;
    sopWorksheetPath?: string;
    sopWorksheetContent?: string;
  },
  tunnelService?: any
): string {
  const agentSetup = getAgentSetup(agentSetupId);
  const coreSections = getCoreSystemSections();
  const styleInstructions = context.aiStyle
    ? getAIStylePrompt(context.aiStyle, context.customAiStylePrompt)
    : '';
  const claudeMdContent = context.repoPath ? getClaudeMdContent(context.repoPath) : '';

  // Build SOP section if available
  let sopSection = '';
  if (context.sopWorksheetPath && context.sopWorksheetContent) {
    sopSection = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STANDARD OPERATING PROCEDURE (SOP) WORKSHEET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A temporary worksheet has been created for you to track progress through the SOP:

INSTRUCTIONS:
- Update this worksheet as you complete each step
- This worksheet is temporary and specific to this chat session

WHEN TO UPDATE:
- Before starting a new major step (mark it [IN PROGRESS])
- After completing a step (mark it complete with [x])
- When filling in blanks

FILE PATH: ${context.sopWorksheetPath}

INITIAL SOP WORKSHEET CONTENT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${context.sopWorksheetContent}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You must follow this SOP. The first thing you do should be to Read and Edit this SOP to mark your current position

There are rare cases where the SOP does not apply. If the SOP does not apply to the user's prompt, you must explain why and say the magic words "SOP does not apply" before responding without the SOP
`;
  }

  // Replace placeholders in the agent's system prompt template
  let prompt = agentSetup.systemPromptTemplate;

  // Replace SOP placeholder FIRST (before other replacements)
  prompt = prompt.replace('{sopWorksheet}', sopSection);

  // Add legacy core sections (backward compatibility)
  const coreSectionsText = Object.values(coreSections).join('\n');
  prompt = prompt.replace('{coreSections}', coreSectionsText);

  // Add modular universal core sections
  const universalCoreSectionsText = Object.values(getUniversalCoreSections()).join('\n');
  prompt = prompt.replace('{universalCoreSections}', universalCoreSectionsText);

  // Add modular GitHub sections
  const githubSectionsText = Object.values(getGitHubSections()).join('\n');
  prompt = prompt.replace('{githubSections}', githubSectionsText);

  // Add modular code sections
  const codeSectionsText = Object.values(getCodeSections()).join('\n');
  prompt = prompt.replace('{codeSections}', codeSectionsText);

  // Add runtime tunnel section (if tunnelService is available)
  // TunnelService is the single source of truth for all tunnel-related state
  if (tunnelService) {
    const runtimeTunnelSection = buildRuntimeTunnelSection(tunnelService, context.userId);
    prompt = prompt.replace('{runtimeTunnels}', runtimeTunnelSection);
  } else {
    // No tunnel service, remove placeholder
    prompt = prompt.replace('{runtimeTunnels}', '');
  }

  // Add user information (always present)
  const headerSections: string[] = [];

  if (context.username && context.userEmail) {
    headerSections.push(`# Current User Information

GitHub Username: ${context.username}
Email: ${context.userEmail}`);
  }

  // Add repository-specific content
  if (context.owner && context.repo) {
    headerSections.push(`You are running Claude Code in the repository: ${context.owner}/${context.repo}
Repository path: ${context.repoPath}`);
  } else if (context.repoPath) {
    headerSections.push(
      `You are running in the Claude workspace root directory: ${context.repoPath}`
    );
  }

  // Prepend all header sections to the prompt
  if (headerSections.length > 0) {
    prompt = headerSections.join('\n\n') + '\n\n' + prompt;
  }

  // Add CLAUDE.md content
  if (claudeMdContent) {
    prompt = prompt + '\n\n' + claudeMdContent;
  }

  // Add style instructions
  if (styleInstructions) {
    prompt = prompt + '\n\n' + styleInstructions;
  }

  // Add local repos list
  if (context.localReposList) {
    prompt =
      prompt +
      '\n\nOTHER' +
      (context.localReposList.startsWith('\n\nLOCALLY')
        ? context.localReposList.substring(2)
        : context.localReposList);
  }

  // Add runtime state
  if (context.runtimeState) {
    prompt = prompt + '\n\n' + context.runtimeState;
  }

  // Add page context
  if (context.pageContext) {
    prompt =
      prompt +
      `\n\nUSER'S CURRENT PAGE CONTEXT (what the user is viewing):
${JSON.stringify(context.pageContext, null, 2)}`;
  }

  return prompt;
}
