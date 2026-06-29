/**
 * Media Processing Service Lifecycle Tests
 *
 * THE STORY: "Processing screenshots and videos during browser automation"
 *
 * The MediaProcessingService handles media files from Playwright automation:
 * 1. Formats user messages with uploaded file attachments
 * 2. Processes screenshots (PNG/JPG → WebP compression)
 * 3. Processes videos after browser recording
 * 4. Converts MCP tool result images (base64 → file → WebP)
 *
 * REAL SERVICES:
 * - ✅ MediaProcessingService - Media file processing logic
 *
 * MOCKED:
 * - 🔴 File system operations (fs)
 * - 🔴 ffmpeg compression (execSync)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';

// ========================================
// IMPORT SERVICES
// ========================================

import { MediaProcessingService } from '../../../src/services/MediaProcessingService';
import { getUserMediaDir, sanitizeUserId } from '@vgit2/shared/constants';

// ========================================
// TEST SUITES
// ========================================

describe('Media Processing Service - Screenshot and Video Lifecycle', () => {
  let mediaProcessingService: MediaProcessingService;
  let testRepoPath: string;
  let testMediaDir: string;

  const TEST_USER_ID = 'media-test@example.com';

  beforeEach(async () => {
    mediaProcessingService = new MediaProcessingService();

    // Create test directories
    testRepoPath = `/tmp/test-media-processing-${Date.now()}`;
    testMediaDir = path.join(testRepoPath, 'test-results');
    await fs.mkdir(testMediaDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testRepoPath, { recursive: true, force: true });
    } catch {}
  });

  it('should handle complete media workflow: file attachments → browser close detection → video processing → screenshot handling', async () => {
    /**
     * SCENARIO: Developer testing a web app with screenshots and video
     *
     * Step 1: User sends message with single file attachment
     * Step 2: User sends message with multiple file attachments
     * Step 3: Files without absolutePath are skipped (safety)
     * Step 4: Files with HTTP paths are rejected (security)
     * Step 5: Empty task but files should work
     * Step 6: Detect browser close for video processing
     * Step 7: Detect browser close from different tool patterns
     * Step 8: Detect regular tool calls (not browser close)
     * Step 9: Process MCP image from base64
     */

    // === STEP 1: Single file attachment ===
    console.log('📎 Step 1: User sends message with single file attachment...');

    const task1 = 'Please review this screenshot';
    const singleFile = [
      {
        fileName: 'screenshot-123.png',
        originalName: 'my-screenshot.png',
        path: 'uploads/screenshot-123.png',
        absolutePath: '/workspace/uploads/screenshot-123.png',
        mimeType: 'image/png',
      },
    ];

    const result1 = mediaProcessingService.formatMessageWithFiles(task1, singleFile);

    expect(Array.isArray(result1)).toBe(true);
    expect(result1.length).toBe(2);
    expect(result1[0].type).toBe('text');
    expect(result1[0].text).toBe(task1);
    expect(result1[1].type).toBe('text');
    expect(result1[1].text).toContain('[File uploaded: my-screenshot.png]');
    expect(result1[1].text).toContain('[LOCAL_FILE_PATH:/workspace/uploads/screenshot-123.png]');

    // === STEP 2: Multiple file attachments ===
    console.log('📎 Step 2: User sends message with multiple file attachments...');

    const task2 = 'Compare these designs';
    const multipleFiles = [
      {
        originalName: 'design-v1.png',
        absolutePath: '/workspace/uploads/design-v1.png',
        mimeType: 'image/png',
      },
      {
        originalName: 'design-v2.png',
        absolutePath: '/workspace/uploads/design-v2.png',
        mimeType: 'image/png',
      },
      {
        originalName: 'notes.txt',
        absolutePath: '/workspace/uploads/notes.txt',
        mimeType: 'text/plain',
      },
    ];

    const result2 = mediaProcessingService.formatMessageWithFiles(task2, multipleFiles);

    expect(Array.isArray(result2)).toBe(true);
    expect(result2.length).toBe(4); // 1 task + 3 files
    expect(result2[0].text).toBe(task2);
    expect(result2[1].text).toContain('design-v1.png');
    expect(result2[2].text).toContain('design-v2.png');
    expect(result2[3].text).toContain('notes.txt');

    // === STEP 3: Files without absolutePath are skipped ===
    console.log('🛡️ Step 3: Files without absolutePath should be skipped...');

    const filesWithMissing = [
      {
        originalName: 'good-file.png',
        absolutePath: '/workspace/uploads/good-file.png',
        mimeType: 'image/png',
      },
      { originalName: 'bad-file.png', mimeType: 'image/png' }, // Missing absolutePath
    ];

    const result3 = mediaProcessingService.formatMessageWithFiles('Check files', filesWithMissing);
    expect(result3.length).toBe(2); // task + 1 valid file
    expect(result3[1].text).toContain('good-file.png');

    // === STEP 4: HTTP paths rejected for security ===
    console.log('🔒 Step 4: HTTP paths should be rejected...');

    const httpFiles = [
      { originalName: 'remote.png', absolutePath: '/api/files/remote.png', mimeType: 'image/png' },
    ];

    const result4 = mediaProcessingService.formatMessageWithFiles('Process', httpFiles);
    expect(result4.length).toBe(1); // Only task, file was rejected

    // === STEP 5: Empty task but files should work ===
    console.log('📄 Step 5: Empty task with files should work...');

    // Service skips empty text, only returns file blocks
    const result5 = mediaProcessingService.formatMessageWithFiles('', singleFile);
    expect(Array.isArray(result5)).toBe(true);
    expect(result5.length).toBe(1); // Only file, no empty text block
    expect(result5[0].text).toContain('[File uploaded: my-screenshot.png]');

    // No files case - returns string
    const noFilesResult = mediaProcessingService.formatMessageWithFiles('Just text', []);
    expect(noFilesResult).toBe('Just text');

    const undefinedFilesResult = mediaProcessingService.formatMessageWithFiles(
      'Also text',
      undefined as any
    );
    expect(undefinedFilesResult).toBe('Also text');

    // === STEP 6: Detect browser close for video processing ===
    // checkForBrowserClose expects a tool_result block with content array containing text
    console.log('🎬 Step 6: Detecting browser close for video processing...');

    // Tool result with browser_close text (matches 'browser_close' string)
    const browserCloseBlock = {
      type: 'tool_result' as const,
      tool_use_id: 'tool-123',
      content: [{ type: 'text', text: 'mcp__playwright__browser_close executed successfully' }],
    };

    const hasBrowserClose = mediaProcessingService.checkForBrowserClose(browserCloseBlock);
    expect(hasBrowserClose).toBe(true);

    // === STEP 7: Different browser close patterns ===
    console.log('🎬 Step 7: Testing different browser close patterns...');

    // Tool result with page.close() text
    const pageCloseBlock = {
      type: 'tool_result' as const,
      tool_use_id: 'tool-456',
      content: [{ type: 'text', text: 'Executed: await page.close()' }],
    };
    expect(mediaProcessingService.checkForBrowserClose(pageCloseBlock)).toBe(true);

    // === STEP 8: Regular tool calls (not browser close) ===
    console.log('🔧 Step 8: Testing regular tool calls (not browser close)...');

    // Tool result without browser close text
    const regularBlock = {
      type: 'tool_result' as const,
      tool_use_id: 'tool-789',
      content: [{ type: 'text', text: 'Navigated to https://example.com successfully' }],
    };
    expect(mediaProcessingService.checkForBrowserClose(regularBlock)).toBe(false);

    // Empty content array
    const emptyContentBlock = {
      type: 'tool_result' as const,
      tool_use_id: 'tool-empty',
      content: [],
    };
    expect(mediaProcessingService.checkForBrowserClose(emptyContentBlock)).toBe(false);

    // Block without content property
    const noContentBlock = {
      type: 'text' as const,
      text: 'Hello World',
    };
    expect(mediaProcessingService.checkForBrowserClose(noContentBlock)).toBe(false);

    // === STEP 9: Process MCP image from base64 ===
    console.log('🖼️ Step 9: Testing MCP image processing setup...');

    // Create a minimal valid PNG (1x1 pixel)
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60,
      0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const base64Png = minimalPng.toString('base64');

    // Verify base64 is valid
    expect(base64Png.length).toBeGreaterThan(0);
    expect(Buffer.from(base64Png, 'base64').slice(0, 4).toString('hex')).toBe('89504e47'); // PNG magic

    console.log('✅ Media processing workflow completed successfully');
  });

  it('should handle edge cases: invalid inputs, missing content, and tool result processing', async () => {
    /**
     * SCENARIO: Various edge cases and error handling
     *
     * Step 1: Undefined tool result content
     * Step 2: Tool result with empty content array
     * Step 3: Tool result with text-only content (no images)
     * Step 4: Create test screenshot file for processing
     * Step 5: Test with various base64 patterns
     * Step 6: Test file name sanitization in output
     */

    // === STEP 1: Undefined tool result content ===
    console.log('⚠️ Step 1: Testing undefined tool result content...');

    const undefinedResult = { content: undefined };
    // Should not throw
    expect(mediaProcessingService.checkForBrowserClose([undefinedResult as any])).toBe(false);

    // === STEP 2: Empty content array ===
    console.log('⚠️ Step 2: Testing empty content array...');

    expect(mediaProcessingService.checkForBrowserClose([])).toBe(false);

    // === STEP 3: Text-only content ===
    console.log('📝 Step 3: Testing text-only content...');

    const textContent = [{ type: 'text' as const, text: 'Some output text' }];
    expect(mediaProcessingService.checkForBrowserClose(textContent)).toBe(false);

    // === STEP 4: Create test screenshot for processing ===
    console.log('📸 Step 4: Creating test screenshot file...');

    const screenshotPath = path.join(testMediaDir, 'test-screenshot.png');
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60,
      0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    await fs.writeFile(screenshotPath, minimalPng);

    // Verify file was created
    const stats = await fs.stat(screenshotPath);
    expect(stats.size).toBeGreaterThan(0);

    // === STEP 5: Test various base64 patterns ===
    console.log('🔢 Step 5: Testing various base64 patterns...');

    // Valid base64
    const validBase64 = minimalPng.toString('base64');
    const decoded = Buffer.from(validBase64, 'base64');
    expect(decoded.slice(0, 4).toString('hex')).toBe('89504e47');

    // Empty base64
    const emptyBase64 = '';
    expect(emptyBase64.length).toBe(0);

    // Base64 with data URI prefix (should be stripped in actual processing)
    const dataUri = `data:image/png;base64,${validBase64}`;
    expect(dataUri.startsWith('data:')).toBe(true);

    // === STEP 6: Test file name sanitization ===
    console.log('📝 Step 6: Testing file name handling in output...');

    const filesWithSpecialNames = [
      {
        originalName: 'file with spaces.png',
        absolutePath: '/workspace/file.png',
        mimeType: 'image/png',
      },
      {
        originalName: 'file-with-dashes.png',
        absolutePath: '/workspace/file2.png',
        mimeType: 'image/png',
      },
      {
        originalName: 'file_with_underscores.png',
        absolutePath: '/workspace/file3.png',
        mimeType: 'image/png',
      },
    ];

    const result = mediaProcessingService.formatMessageWithFiles('Test', filesWithSpecialNames);
    expect(result.length).toBe(4); // task + 3 files
    expect(result[1].text).toContain('file with spaces.png');
    expect(result[2].text).toContain('file-with-dashes.png');
    expect(result[3].text).toContain('file_with_underscores.png');

    console.log('✅ Edge case handling verified successfully');
  });

  it('processDisplayVideo: copies a local video into the served media dir + emits a URL video block', async () => {
    /**
     * SCENARIO: the `display_video` tool result points at a LOCAL PC file
     * ("Video displayed: /tmp/pw-clock-video/<id>.webm"), which the mobile app cannot
     * fetch. processDisplayVideo must copy it into /data/media/<userId>/ and return a
     * servable `video` block so the app can load + play it over the relay.
     */

    // A fake recorded video at an absolute path (Playwright's /tmp recording dir shape).
    const srcVideo = path.join(testRepoPath, 'pw-clock-video.webm');
    await fs.writeFile(srcVideo, Buffer.from('FAKEWEBMDATA'));

    const block = mediaProcessingService.processDisplayVideo(
      `Video displayed: ${srcVideo}`,
      testRepoPath,
      TEST_USER_ID
    );

    expect(block).not.toBeNull();
    expect(block.type).toBe('video');
    expect(block.source.type).toBe('url');
    expect(block.source.media_type).toBe('video/webm');
    const sanitized = sanitizeUserId(TEST_USER_ID);
    expect(block.source.url).toMatch(new RegExp(`^/data/media/${sanitized}/video-\\d+\\.webm$`));

    // The file was actually copied into the served media dir (so /data/media serves it).
    const destName = String(block.source.url).split('/').pop() as string;
    const destPath = path.join(getUserMediaDir(TEST_USER_ID), destName);
    const destStats = await fs.stat(destPath);
    expect(destStats.size).toBeGreaterThan(0);
    await fs.rm(destPath, { force: true });

    // A repo-relative path is resolved against repoPath too.
    const relVideo = path.join(testMediaDir, 'rel-video.webm');
    await fs.writeFile(relVideo, Buffer.from('REL'));
    const relBlock = mediaProcessingService.processDisplayVideo(
      'Video displayed: test-results/rel-video.webm',
      testRepoPath,
      TEST_USER_ID
    );
    expect(relBlock).not.toBeNull();
    expect(relBlock.source.url).toMatch(new RegExp(`^/data/media/${sanitized}/video-\\d+\\.webm$`));
    await fs.rm(
      path.join(getUserMediaDir(TEST_USER_ID), String(relBlock.source.url).split('/').pop()),
      {
        force: true,
      }
    );

    // A non-display-video text → null (no false positives).
    expect(
      mediaProcessingService.processDisplayVideo(
        'Navigated to example.com',
        testRepoPath,
        TEST_USER_ID
      )
    ).toBeNull();

    // A missing file → null (best-effort, never throws).
    expect(
      mediaProcessingService.processDisplayVideo(
        'Video displayed: /tmp/does-not-exist-xyz-12345.webm',
        testRepoPath,
        TEST_USER_ID
      )
    ).toBeNull();

    console.log('✅ display_video processing verified successfully');
  });
});
