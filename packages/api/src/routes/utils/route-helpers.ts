import { stripTaskNotifications } from '@vgit2/shared/utils/taskNotificationHelpers';
import { Request } from 'express';

/**
 * Helper to extract JWT from Authorization header or session
 * Used for request authentication
 *
 * Priority:
 * 1. Authorization header (production, remote sandboxes)
 * 2. Session authToken (development, tests)
 */
export function getAuthToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  // Fallback to session token for tests and dev mode
  return req.session?.authToken;
}

/**
 * Get user email from session (handles both sandbox and dev OAuth modes)
 * - Sandbox: req.session.userEmail
 * - Dev OAuth: req.session.githubUser.email
 *
 * NOTE: This function is exported but rarely needed in routes since requireAuth
 * middleware already guarantees req.session.userEmail exists for authenticated routes.
 * Use req.session.userEmail! directly in authenticated routes instead.
 */
export function getUserEmail(req: Request): string | undefined {
  return req.session?.userEmail || req.session?.githubUser?.email;
}

/**
 * Helper to extract text preview from a message
 * Matches the logic in ChatBox.tsx for activeChatLabel
 */
export function extractMessagePreview(message: any): string {
  if (!message) return '';

  // Check for custom display first
  if (message.customDisplay) {
    if (message.customDisplay.category === 'quickAction') {
      // Include both label and labelBold to match QuickActionPill UI
      const label = message.customDisplay.action?.label || '';
      const labelBold = message.customDisplay.action?.labelBold || '';
      return labelBold ? `${label} ${labelBold}` : label;
    } else if (
      message.customDisplay.category === 'message' ||
      message.customDisplay.category === 'plainMessage'
    ) {
      return message.customDisplay.displayText || '';
    }
  }

  let content = '';

  // Check blocks FIRST (blocks take priority over content field)
  if (message.blocks && message.blocks.length > 0) {
    // Find LAST text block with content
    const textBlocks = message.blocks.filter(
      (b: any) =>
        b.type === 'text' && (b.text || b.content) && (b.text?.trim() || b.content?.trim())
    );

    if (textBlocks.length > 0) {
      const textBlock = textBlocks[textBlocks.length - 1];
      content = (textBlock?.text || textBlock?.content || '').trim();
    } else {
      // No text blocks - extract preview from non-text blocks
      let previewBlock: any = null;
      for (let i = message.blocks.length - 1; i >= 0; i--) {
        const block = message.blocks[i];
        if (block.type !== 'tool_result') {
          previewBlock = block;
          break;
        }
      }

      if (previewBlock) {
        switch (previewBlock.type) {
          case 'tool_use':
            content = `Used ${previewBlock.toolName || 'tool'}`;
            break;
          case 'image':
            content = '📷 Image';
            break;
          case 'video':
            content = '🎥 Video';
            break;
          default:
            content = '';
        }
      }
    }
  } else if (typeof message.content === 'string') {
    // Fallback: If no blocks, use content field directly
    content = message.content.trim();
  } else if (Array.isArray(message.content)) {
    // Content is array of blocks (legacy format)
    const textBlocks = message.content.filter(
      (b: any) => b.type === 'text' && (b.text || b.content)
    );
    if (textBlocks.length > 0) {
      const lastBlock = textBlocks[textBlocks.length - 1];
      content = (lastBlock.text || lastBlock.content || '').trim();
    }
  }

  // Strip injected task-notification metadata BEFORE truncating: the mobile client
  // also strips at render time, but its regex needs the closing tag — which the
  // 100-char cut destroys, leaking raw XML into chat cards (public issue #11). We use
  // the STRICT strip (not the truncation-tolerant preview variant): `content` here is
  // the full stored message, where an SDK-injected blob is always complete, so the
  // strict regex is lossless — it never chops a human message that merely mentions the
  // marker without closing it.
  content = stripTaskNotifications(content);

  // Truncate to 100 characters for preview
  if (content.length > 100) {
    content = content.substring(0, 100) + '...';
  }

  return content;
}

/**
 * Safely extract a single string value from query parameter
 * Throws error if parameter is an array (invalid input)
 */
export function getQueryParam(
  value: string | string[] | undefined,
  paramName: string
): string | undefined {
  if (Array.isArray(value)) {
    throw new Error(`Invalid query parameter '${paramName}': expected single value, got array`);
  }
  return value;
}

/**
 * Safely extract a required single string value from query parameter
 * Throws error if parameter is an array or undefined
 */
export function getRequiredQueryParam(
  value: string | string[] | undefined,
  paramName: string
): string {
  if (Array.isArray(value)) {
    throw new Error(`Invalid query parameter '${paramName}': expected single value, got array`);
  }
  if (!value) {
    throw new Error(`Missing required query parameter '${paramName}'`);
  }
  return value;
}
