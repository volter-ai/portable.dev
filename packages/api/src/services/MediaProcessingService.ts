import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import fsSync from 'fs';
import path from 'path';

import { getUserMediaDir, sanitizeUserId } from '@vgit2/shared/constants';

/**
 * MediaProcessingService handles media file processing including:
 * - Screenshot compression (PNG/JPG → WebP)
 * - MCP image conversion (base64 → WebP)
 * - Video file preparation (browser recordings)
 * - Message formatting with file attachments
 */
export class MediaProcessingService {
  /**
   * Format message content with uploaded files
   * Returns content blocks with file paths for AI to access
   */
  formatMessageWithFiles(task: string, uploadedFiles: any[] = []): string | any[] {
    console.log(
      `[MediaProcessingService] formatMessageWithFiles called with ${uploadedFiles?.length || 0} files`
    );

    if (!uploadedFiles || uploadedFiles.length === 0) {
      console.log(`[MediaProcessingService] No files to process, returning task as-is`);
      return task;
    }

    console.log(`[MediaProcessingService] Processing ${uploadedFiles.length} uploaded files:`);
    uploadedFiles.forEach((file, i) => {
      console.log(`[MediaProcessingService]   File ${i + 1}:`, {
        fileName: file.fileName,
        originalName: file.originalName,
        path: file.path,
        absolutePath: file.absolutePath,
        mimeType: file.mimeType,
      });
    });

    // Create content blocks with text and file references
    const contentBlocks: any[] = [];

    // Add text content first if present
    if (task) {
      contentBlocks.push({
        type: 'text',
        text: task,
      });
    }

    // Add file references with workspace-relative paths
    for (const file of uploadedFiles) {
      // Use absolutePath (absolute workspace path) for AI to access the file
      const filePath = file.absolutePath;

      // SAFETY: Only use absolute paths, never HTTP paths
      if (!filePath) {
        console.error(
          '[MediaProcessingService] ERROR - Missing absolutePath for uploaded file:',
          file.originalName
        );
        console.error('[MediaProcessingService] ERROR - Full file object:', file);
        continue; // Skip this file if no absolute path
      }

      if (filePath.startsWith('/api/')) {
        console.error(
          '[MediaProcessingService] ERROR - Received HTTP path instead of file path:',
          filePath
        );
        console.error('[MediaProcessingService] ERROR - Full file object:', file);
        continue; // Skip this file if it's an HTTP path
      }

      contentBlocks.push({
        type: 'text',
        text: `\n\n[File uploaded: ${file.originalName}]\n[LOCAL_FILE_PATH:${filePath}]`,
      });
    }

    return contentBlocks;
  }

  /**
   * Check if a tool_result indicates browser close
   */
  checkForBrowserClose(block: any): boolean {
    if (Array.isArray(block.content)) {
      for (const contentBlock of block.content) {
        if (contentBlock.type === 'text' && contentBlock.text) {
          if (
            contentBlock.text.includes('await page.close()') ||
            contentBlock.text.includes('browser_close')
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Process video after browser close
   * Finds the most recent .webm file, reads it, and prepares for upload
   */
  processVideoAfterBrowserClose(repoPath: string): any | null {
    try {
      const testResultsDir = path.join(repoPath, 'test-results');
      if (fsSync.existsSync(testResultsDir)) {
        // Find the most recent .webm file
        const files = fsSync
          .readdirSync(testResultsDir)
          .filter((f) => f.endsWith('.webm'))
          .map((f) => ({
            name: f,
            path: path.join(testResultsDir, f),
            mtime: fsSync.statSync(path.join(testResultsDir, f)).mtime,
          }))
          .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (files.length > 0) {
          const latestVideo = files[0];
          console.log(
            `[MediaProcessingService] Found video after browser close: ${latestVideo.name}`
          );

          // Move the video file to sent-videos folder
          const sentVideosDir = path.join(repoPath, 'test-results', 'sent-videos');
          if (!fsSync.existsSync(sentVideosDir)) {
            fsSync.mkdirSync(sentVideosDir, { recursive: true });
          }
          const movedPath = path.join(sentVideosDir, latestVideo.name);
          fsSync.renameSync(latestVideo.path, movedPath);

          // Get video size for logging
          const videoStats = fsSync.statSync(movedPath);
          const sizeMB = (videoStats.size / 1024 / 1024).toFixed(2);
          console.log(`[MediaProcessingService] Moved video to: ${movedPath} (${sizeMB}MB)`);

          // Extract repo info from path for video URL
          const repoPathSegments = repoPath.split('/').filter((s) => s && s !== '~');

          // Check if this is orchestrator mode (workspace root) or repo mode
          const workspaceIndex = repoPathSegments.indexOf('claude-workspace');
          const isOrchestratorMode =
            workspaceIndex >= 0 && repoPathSegments.length === workspaceIndex + 2;

          let owner: string;
          let repo: string;
          let relativePath: string;

          if (isOrchestratorMode) {
            // Orchestrator mode: use placeholder values
            owner = '_workspace';
            repo = '_temp';
            relativePath = path.basename(movedPath); // Just the filename
          } else {
            // Repo mode: extract owner/repo from path
            repo = repoPathSegments[repoPathSegments.length - 1];
            owner = repoPathSegments[repoPathSegments.length - 2];
            relativePath = path.relative(repoPath, movedPath);
          }

          console.log(
            `[MediaProcessingService] Video ready, serving via URL: /api/video/${owner}/${repo}/${relativePath} (orchestrator: ${isOrchestratorMode})`
          );

          // Send video reference instead of base64 data
          return {
            type: 'video',
            blockId: randomUUID(), // Unique identifier for deduplication and references
            videoPath: `${owner}/${repo}/${relativePath}`, // Relative path for /api/video endpoint
            source: {
              type: 'url',
              media_type: 'video/webm',
              url: `/api/video/${owner}/${repo}/${relativePath}`,
            },
          };
        }
      }
    } catch (error) {
      console.error(`[MediaProcessingService] Failed to process video after browser close:`, error);
    }
    return null;
  }

  /**
   * Process a `display_video` tool result.
   *
   * The `display_video` tool only returns a text confirmation pointing at a LOCAL
   * file on the PC (e.g. `Video displayed: /tmp/pw-clock-video/<id>.webm`), which the
   * mobile app cannot fetch. To make it displayable in local-first mode we mirror the
   * screenshot path: copy the file into the user's served media dir and emit a
   * URL-based `video` block. `/data/media/:userId/:filename` is served by `server.ts`
   * (before the JWT middleware → public) and forwarded by the relay, so the app loads
   * it over `<gatewayBase>/t/<pcId>/data/media/...` and plays it with expo-video.
   *
   * The path may be absolute (Playwright's `/tmp/pw-*` recording dir) or repo-relative
   * (`test-results/video.webm`, the tool's documented contract) — both are resolved.
   * Best-effort: any failure returns null (the tool's text confirmation still shows).
   */
  processDisplayVideo(text: string, repoPath: string, userId: string): any | null {
    const match = text.match(/Video displayed:\s*(\S+\.(?:webm|mp4|mov|m4v))/i);
    if (!match) {
      return null;
    }

    let srcPath = match[1];
    if (!path.isAbsolute(srcPath)) {
      srcPath = path.join(repoPath, srcPath);
    }

    try {
      if (!fsSync.existsSync(srcPath)) {
        console.error(`[MediaProcessingService] display_video file not found: ${srcPath}`);
        return null;
      }

      const publicMediaDir = getUserMediaDir(userId);
      if (!fsSync.existsSync(publicMediaDir)) {
        fsSync.mkdirSync(publicMediaDir, { recursive: true });
      }

      const timestamp = Date.now();
      const ext = (path.extname(srcPath) || '.webm').toLowerCase();
      const destName = `video-${timestamp}${ext}`;
      const destPath = path.join(publicMediaDir, destName);

      // Copy (not move) — the tool's source path may still be referenced elsewhere.
      fsSync.copyFileSync(srcPath, destPath);

      const userIdentifier = sanitizeUserId(userId);
      const mediaType =
        ext === '.mp4' || ext === '.m4v'
          ? 'video/mp4'
          : ext === '.mov'
            ? 'video/quicktime'
            : 'video/webm';
      const publicUrl = `/data/media/${userIdentifier}/${destName}`;

      console.log(`[MediaProcessingService] display_video served via public URL: ${publicUrl}`);

      return {
        type: 'video',
        blockId: randomUUID(),
        videoPath: `${userIdentifier}/${destName}`,
        source: {
          type: 'url',
          media_type: mediaType,
          url: publicUrl,
        },
      };
    } catch (error) {
      console.error(`[MediaProcessingService] Failed to process display_video:`, error);
      return null;
    }
  }

  /**
   * Process screenshot from Playwright tool result
   * Detects screenshot paths, compresses to WebP, and prepares for upload
   */
  processScreenshot(text: string, repoPath: string, userId: string): any | null {
    // Match various formats: test-results/file.png, /abs/path/test-results/file.png, or "Screenshot saved to file.png"
    const screenshotMatch = text.match(
      /(?:saved to |test-results\/|screenshot[:\s]+)([^'"\s]*\.(?:png|jpg|jpeg|webp))/i
    );
    if (!screenshotMatch) {
      return null;
    }

    let screenshotPath = screenshotMatch[1];
    // If it's a relative path starting with test-results/, join with repoPath
    if (screenshotPath.startsWith('test-results/')) {
      screenshotPath = path.join(repoPath, screenshotPath);
    } else if (!path.isAbsolute(screenshotPath)) {
      // If it's just a filename, assume it's in test-results/
      screenshotPath = path.join(repoPath, 'test-results', screenshotPath);
    }
    console.log(
      `[MediaProcessingService] Detected screenshot path in tool result: ${screenshotPath}`
    );

    try {
      // Check if source file exists
      if (!fsSync.existsSync(screenshotPath)) {
        console.error(`[MediaProcessingService] Screenshot file not found: ${screenshotPath}`);
        return null;
      }

      // Get user-specific media directory (handles dev/prod/user container automatically)
      const publicMediaDir = getUserMediaDir(userId);
      if (!fsSync.existsSync(publicMediaDir)) {
        fsSync.mkdirSync(publicMediaDir, { recursive: true });
      }

      // Compress screenshot to WebP using ffmpeg
      const timestamp = Date.now();
      const webpPath = path.join(publicMediaDir, `screenshot-${timestamp}.webp`);

      console.log(
        `[MediaProcessingService] Compressing screenshot: ${screenshotPath} -> ${webpPath}`
      );

      try {
        execSync(`ffmpeg -i "${screenshotPath}" -c:v libwebp -quality 70 "${webpPath}" -y`, {
          stdio: 'pipe',
        });
        console.log(`[MediaProcessingService] Compressed screenshot to: ${webpPath}`);
      } catch (ffmpegError: any) {
        console.error(`[MediaProcessingService] ffmpeg compression failed:`, ffmpegError.message);
        console.error(`[MediaProcessingService] ffmpeg stderr:`, ffmpegError.stderr?.toString());
        return null;
      }

      // Generate public URL for serving
      // Public URL always includes userIdentifier for Caddy to serve correctly
      // (File system path differs: user containers save to /data/media/, main saves to /data/media/{userId}/)
      const userIdentifier = sanitizeUserId(userId);
      const publicUrl = `/data/media/${userIdentifier}/screenshot-${timestamp}.webp`;

      console.log(
        `[MediaProcessingService] Screenshot compressed, serving via public URL: ${publicUrl}`
      );

      // Send image URL instead of base64 data
      return {
        type: 'image',
        blockId: randomUUID(), // Unique identifier for deduplication and references
        source: {
          type: 'url',
          media_type: 'image/webp',
          url: publicUrl,
        },
        imagePath: `${userIdentifier}/screenshot-${timestamp}.webp`, // For client reference
      };
    } catch (error) {
      console.error(`[MediaProcessingService] Failed to compress screenshot:`, error);
      return null;
    }
  }

  /**
   * Process image from MCP tool result (base64 → file)
   *
   * Extracts base64 data from MCP image blocks, saves to file system,
   * compresses to WebP, and returns URL-based block for storage/streaming.
   *
   * This prevents base64 bloat in chat messages (500KB+ → 100 bytes).
   *
   * @param resultBlock - Image block from MCP tool result
   * @param userId - User identifier (email) for folder isolation
   * @returns URL-based image block or null if already URL/invalid
   */
  processMcpImage(resultBlock: any, userId: string): any | null {
    try {
      const source = resultBlock.source;

      // Only process base64 images (skip if already URL)
      if (source?.type !== 'base64' || !source.data) {
        return null;
      }

      const base64Data = source.data;
      const mediaType = source.media_type || 'image/png';

      console.log(
        `[MediaProcessingService] Processing MCP image (${mediaType}, ${(
          base64Data.length / 1024
        ).toFixed(2)}KB base64)`
      );

      // Get user-specific media directory (handles dev/prod/user container automatically)
      const publicMediaDir = getUserMediaDir(userId);

      // Create directory if it doesn't exist
      if (!fsSync.existsSync(publicMediaDir)) {
        fsSync.mkdirSync(publicMediaDir, { recursive: true });
        console.log(`[MediaProcessingService] Created media directory: ${publicMediaDir}`);
      }

      // Save base64 to temporary file
      const timestamp = Date.now();
      const tempPath = path.join(publicMediaDir, `mcp-temp-${timestamp}.png`);
      const imageBuffer = Buffer.from(base64Data, 'base64');
      fsSync.writeFileSync(tempPath, imageBuffer);

      console.log(`[MediaProcessingService] Temporary file saved: ${tempPath}`);

      // Compress to WebP (same as screenshots)
      const webpPath = path.join(publicMediaDir, `mcp-image-${timestamp}.webp`);

      try {
        execSync(`ffmpeg -i "${tempPath}" -c:v libwebp -quality 70 "${webpPath}" -y`, {
          stdio: 'pipe',
        });
        console.log(`[MediaProcessingService] Compressed MCP image to: ${webpPath}`);
      } catch (ffmpegError: any) {
        console.error(`[MediaProcessingService] ffmpeg compression failed:`, ffmpegError.message);
        // Clean up temp file and return null (will use fallback)
        fsSync.unlinkSync(tempPath);
        return null;
      }

      // Clean up temporary file
      fsSync.unlinkSync(tempPath);

      // Generate public URL for serving
      const userIdentifier = sanitizeUserId(userId);
      const publicUrl = `/data/media/${userIdentifier}/mcp-image-${timestamp}.webp`;

      console.log(`[MediaProcessingService] MCP image saved and compressed: ${publicUrl}`);

      // Return URL-based block (replaces base64)
      return {
        type: 'image',
        blockId: randomUUID(), // Unique identifier for deduplication and references
        source: {
          type: 'url',
          media_type: 'image/webp',
          url: publicUrl,
        },
        imagePath: `${userIdentifier}/mcp-image-${timestamp}.webp`,
      };
    } catch (error) {
      console.error(`[MediaProcessingService] Failed to process MCP image:`, error);
      return null;
    }
  }
}
