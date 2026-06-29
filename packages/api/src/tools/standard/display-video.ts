import type { ToolExecutionContext, ToolResult } from '../types.js';

// ============================================================================
// DISPLAY VIDEO TOOL
// ============================================================================
// This tool displays a video file to the user inline in the chat.
// Use this after recording a video with Playwright.
// ============================================================================

/**
 * Display Video Tool
 *
 * Displays a video file to the user. The client will detect this tool use and render the video player.
 */
export const displayVideoTool = {
  name: 'display_video',
  description:
    'Display a video file to the user. Use this after recording a video with Playwright. The video will be shown inline in the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      video_path: {
        type: 'string',
        description:
          'The relative path to the video file from the repository root (e.g., test-results/video.webm)',
      },
    },
    required: ['video_path'],
  },
  execute: async (input: any, _context: ToolExecutionContext): Promise<ToolResult> => {
    const { video_path } = input;

    // The client will detect this tool use and render the video player
    // Just return a simple confirmation
    return {
      content: [
        {
          type: 'text',
          text: `Video displayed: ${video_path}`,
        },
      ],
    };
  },
};
