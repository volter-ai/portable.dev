/**
 * Tool Color System.
 *
 * Each tool family gets its own distinct color for visual recognition. Colors are
 * theme-independent and indicate the tool family. The only nuance is that the
 * unified opacity constants are DECLARED here (rather than imported from
 * `theme.ts`, which would create a require cycle on RN).
 *
 *  - Core file operations (Read, Write, Edit, Glob, Grep) = semantic colors
 *  - Tool families (Bash, Playwright, Tunnel, GitHub, …)  = distinct per family
 *  - System tools (Task, TodoWrite)                       = neutral gray
 */

// Unified opacity constants for ALL tool blocks (custom + core). Declared here so
// `theme.ts` re-exports them (single source, no require cycle).
export const TOOL_BLOCK_OPACITY = 0.2; // 20% opacity for rgba() backgrounds
export const TOOL_BLOCK_OPACITY_HEX = '33'; // hex ~20% for color+suffix format
export const TOOL_BLOCK_HOVER_OPACITY = 0.3; // 30% opacity for hover states

export const TOOL_COLORS = {
  // Core file operations - semantic colors
  read: '#60a5fa', // Light Blue - Read, Glob, Grep (subtle/passive)
  write: '#16A34A', // Forest Green - Write, create operations
  edit: '#EA580C', // Warm Amber - Edit, modify operations

  // Tool family colors - the icon colors used in blocks
  bash: '#1f2937', // Very Dark Grey - background (icon overridden to white)
  bashOutput: '#64748B', // Neutral Gray
  playwright: '#3b82f6', // Bright Blue - browser automation
  tunnel: '#F97316', // Vibrant Orange - network tunneling
  github: '#24292e', // GitHub Dark Gray
  imageAnalysis: '#06b6d4', // Cyan
  videoAnalysis: '#ef4444', // Red

  // Generic types
  system: '#64748B', // Neutral Gray - Task, TodoWrite, system tools
  permission: '#F59E0B', // Alert Orange - needs permission
  error: '#DC2626', // Error Red - ONLY for errors, never for operations
} as const;

/** ToolColors structure with opacity variants (one per tool family). */
export interface ToolColors {
  icon: string; // Primary color for icon (100% opacity)
  border: string; // Border color (100% opacity)
  soft: string; // Soft background (TOOL_BLOCK_OPACITY)
  hover: string; // Hover background (TOOL_BLOCK_HOVER_OPACITY)
  text: string; // Text color (same as icon)
  softer: string; // Even softer background (TOOL_BLOCK_OPACITY)
}

/** Convert hex color to rgba with opacity. */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Create ToolColors structure from a hex color (unified opacity constants). */
export function createToolColors(hex: string): ToolColors {
  return {
    icon: hex,
    border: hex,
    text: hex,
    soft: hexToRgba(hex, TOOL_BLOCK_OPACITY),
    hover: hexToRgba(hex, TOOL_BLOCK_HOVER_OPACITY),
    softer: hexToRgba(hex, TOOL_BLOCK_OPACITY),
  };
}

/**
 * Create ToolColors with a custom icon/text color (e.g. bash = white icon on a
 * dark background). `bgHex` drives soft/hover/softer; `iconHex` the icon/border/text.
 */
function createToolColorsWithCustomIcon(bgHex: string, iconHex: string): ToolColors {
  return {
    icon: iconHex,
    border: iconHex,
    text: iconHex,
    soft: hexToRgba(bgHex, TOOL_BLOCK_OPACITY),
    hover: hexToRgba(bgHex, TOOL_BLOCK_HOVER_OPACITY),
    softer: hexToRgba(bgHex, TOOL_BLOCK_OPACITY),
  };
}

/** Complete tool color palette with all tool families. */
export interface ToolColorPalette {
  read: ToolColors;
  write: ToolColors;
  edit: ToolColors;

  bash: ToolColors;
  bashOutput: ToolColors;
  playwright: ToolColors;
  tunnel: ToolColors;
  github: ToolColors;
  imageAnalysis: ToolColors;
  videoAnalysis: ToolColors;

  system: ToolColors;
  permission: ToolColors;

  // Legacy compatibility mappings
  bash_output: ToolColors;
  grep: ToolColors;
  special: ToolColors;
}

/** Create the unified tool color palette (consistent across all themes). */
export function createUnifiedToolPalette(): ToolColorPalette {
  return {
    read: createToolColors(TOOL_COLORS.read),
    write: createToolColors(TOOL_COLORS.write),
    edit: createToolColors(TOOL_COLORS.edit),

    bash: createToolColorsWithCustomIcon(TOOL_COLORS.bash, '#FFFFFF'),
    bashOutput: createToolColors(TOOL_COLORS.bashOutput),
    playwright: createToolColors(TOOL_COLORS.playwright),
    tunnel: createToolColors(TOOL_COLORS.tunnel),
    github: createToolColors(TOOL_COLORS.github),
    imageAnalysis: createToolColors(TOOL_COLORS.imageAnalysis),
    videoAnalysis: createToolColors(TOOL_COLORS.videoAnalysis),

    system: createToolColors(TOOL_COLORS.system),
    permission: createToolColors(TOOL_COLORS.permission),

    bash_output: createToolColors(TOOL_COLORS.bashOutput),
    grep: createToolColors(TOOL_COLORS.read),
    special: createToolColors(TOOL_COLORS.playwright),
  };
}

/** Map a tool name to its tool family (which color it uses). */
export function getToolOperationType(toolName: string): keyof typeof TOOL_COLORS {
  if (toolName === 'Read') return 'read';
  if (toolName === 'Write') return 'write';
  if (toolName === 'Edit') return 'edit';
  if (toolName === 'MultiEdit') return 'edit';
  if (toolName === 'Grep') return 'read';
  if (toolName === 'Glob') return 'read';
  if (toolName === 'WebSearch') return 'read';
  if (toolName === 'NotebookEdit') return 'edit';

  if (toolName === 'Bash') return 'bash';
  if (toolName === 'BashOutput') return 'bashOutput';
  if (toolName === 'KillShell') return 'bash';

  if (toolName.startsWith('mcp__playwright__')) return 'playwright';

  if (toolName === 'create_tunnel' || toolName === 'show_tunnel') return 'tunnel';

  if (toolName === 'TodoWrite') return 'system';
  if (toolName === 'Task') return 'system';
  if (toolName === 'Skill') return 'system';
  if (toolName === 'SlashCommand') return 'system';
  if (toolName === 'EnterPlanMode') return 'system';
  if (toolName === 'ExitPlanMode') return 'system';
  if (toolName === 'AskUserQuestion') return 'system';

  return 'system';
}
