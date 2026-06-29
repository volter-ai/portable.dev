import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import { getUserUploadDir, getUserWorkspaceDir, shouldLog } from '@vgit2/shared/constants';
import { Request, Response } from 'express';
import multer from 'multer';

import type { LocalAiHelper } from './ai/LocalAiHelper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * UploadService handles file uploads and audio transcription
 */
export class UploadService {
  private upload: multer.Multer;
  // Local-first one-shot AI helper — reserved for the future local transcription
  // post-processing path (see handleAudioTranscription / packages/api/CLAUDE.md TODO).
  private localAiHelper?: LocalAiHelper;

  constructor(localAiHelper?: LocalAiHelper) {
    // Setup multer for file uploads (memory storage)
    this.upload = multer({ storage: multer.memoryStorage() });
    if (shouldLog('debug')) {
      console.log('[UploadService] Multer configured');
    }

    // Local-first AI helper (Claude Haiku, user's own credential) — for future STT post-processing.
    this.localAiHelper = localAiHelper;

    if (shouldLog('debug')) {
      console.log('[UploadService] Initialized');
    }
  }

  /**
   * Get multer middleware
   */
  getUploadMiddleware() {
    return this.upload;
  }

  /**
   * Handle file upload
   */
  async handleFileUpload(req: Request, res: Response): Promise<void> {
    console.log('[UPLOAD] Endpoint hit');

    // Authentication is handled by requireAuth middleware
    try {
      if (!req.file) {
        console.log('[UPLOAD] No file in request');
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      console.log('[UPLOAD] File received:', {
        originalName: req.file.originalname,
        size: req.file.buffer.length,
        mimetype: req.file.mimetype,
      });

      // Generate unique filename
      const fileExt = path.extname(req.file.originalname);
      const fileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${fileExt}`;

      // Get user email for workspace directory
      const userEmail = req.session.userEmail;
      if (!userEmail) {
        res.status(401).json({ error: 'Unauthorized: User email not found in session' });
        return;
      }

      // Save directly to user's workspace upload directory (no temp storage)
      const userUploadDir = getUserUploadDir(userEmail);
      await fs.mkdir(userUploadDir, { recursive: true });

      const userFilePath = path.join(userUploadDir, fileName);
      await fs.writeFile(userFilePath, req.file.buffer);
      console.log('[UPLOAD] File saved directly to user workspace:', userFilePath);

      // Return file info with filesystem path (the client will transform to HTTP URL for display)
      res.json({
        fileName,
        originalName: req.file.originalname,
        path: userFilePath, // Filesystem path (transformed to HTTP URL in the client)
        absolutePath: userFilePath, // Absolute path to workspace file for AI access
        mimeType: req.file.mimetype,
        size: req.file.buffer.length,
      });
    } catch (error: any) {
      console.error('[UPLOAD] Error:', error);
      res.status(500).json({ error: 'Failed to upload file' });
    }
  }

  /**
   * Serve uploaded file from user's workspace directory
   *
   * Authentication via Express session (populated by JWT middleware or OAuth)
   * Route /api/uploads/ is public in JWT middleware, but still requires valid session
   */
  async serveUploadedFile(req: Request, res: Response): Promise<void> {
    // Authentication is handled by requireAuth middleware
    // Check user email
    const userEmail = req.session.userEmail;
    if (!userEmail) {
      res.status(401).json({ error: 'Unauthorized: User email not found in session' });
      return;
    }

    try {
      const filename = req.params.filename;

      // Serve from user's workspace upload directory (ensures user isolation)
      const userUploadDir = getUserUploadDir(userEmail);
      const filePath = path.join(userUploadDir, filename as string);

      // Check if file exists
      await fs.access(filePath);

      // Send file
      res.sendFile(filePath);
    } catch (error) {
      console.error('[UPLOAD] Error serving file:', error);
      res.status(404).json({ error: 'File not found' });
    }
  }

  /**
   * Serve any file from user's workspace directory (for AI-generated file:// URLs)
   *
   * This endpoint serves files referenced by AI tools anywhere within the user's workspace,
   * not just the uploads directory. Common use case: AI image/video generation tools that
   * reference local files as input (e.g., file:///workspace/user/repo/assets/image.jpg)
   *
   * Security measures:
   * - User authentication required
   * - Per-user workspace isolation via getUserWorkspaceDir()
   * - Path validation with absolute path resolution
   * - Directory traversal prevention (reject .. in paths)
   * - File existence verification
   */
  async serveWorkspaceFile(req: Request, res: Response): Promise<void> {
    // Authentication is handled by requireAuth middleware
    // Check user email
    const userEmail = req.session.userEmail;
    if (!userEmail) {
      res.status(401).json({ error: 'Unauthorized: User email not found in session' });
      return;
    }

    try {
      const fileUrl = req.query.path as string;

      if (!fileUrl) {
        res.status(400).json({ error: 'Missing path parameter' });
        return;
      }

      // Strip file:// protocol if present
      const filePath = fileUrl.startsWith('file://') ? fileUrl.slice(7) : fileUrl;

      // Security: Check for directory traversal attempts
      if (filePath.includes('..')) {
        console.error('[WORKSPACE-FILE] Directory traversal attempt:', filePath);
        res.status(400).json({ error: 'Invalid path: directory traversal not allowed' });
        return;
      }

      // Security: Resolve to absolute path
      const absolutePath = path.resolve(filePath);

      // Security: Validate path is within user's workspace directory
      const userWorkspace = getUserWorkspaceDir(userEmail);
      if (!absolutePath.startsWith(userWorkspace)) {
        console.error('[WORKSPACE-FILE] Path outside workspace:', {
          requested: absolutePath,
          workspace: userWorkspace,
        });
        res.status(403).json({ error: 'Access denied: file outside workspace' });
        return;
      }

      // Check if file exists
      await fs.access(absolutePath);

      // Log successful access
      console.log('[WORKSPACE-FILE] Serving file:', {
        user: userEmail,
        file: absolutePath,
      });

      // Send file
      res.sendFile(absolutePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.error('[WORKSPACE-FILE] File not found:', error);
        res.status(404).json({ error: 'File not found' });
      } else {
        console.error('[WORKSPACE-FILE] Error serving file:', error);
        res.status(500).json({ error: 'Failed to serve file' });
      }
    }
  }

  /**
   * Audio transcription endpoint.
   *
   * ⚠️ UNAVAILABLE in local-first mode. There is no local speech-to-text provider:
   * the PC has ONLY the user's own Anthropic credential, and Anthropic has no
   * speech-to-text API. Rather than 500, this fails cleanly (501).
   *
   * TODO: wire a local / BYO-key STT provider, then resume the optional Claude Haiku
   * post-processing via `this.localAiHelper` (the user's own credential).
   */
  async handleAudioTranscription(_req: Request, res: Response): Promise<void> {
    console.warn(
      '[TRANSCRIBE] Voice transcription is unavailable in local mode (no local STT provider)'
    );
    res.status(501).json({
      error: 'Voice transcription is not available in local mode yet.',
      code: 'transcription_unavailable',
    });
  }

  /**
   * Validate file (size, type, etc.)
   */
  validateFile(
    file: Express.Multer.File,
    options: {
      maxSize?: number;
      allowedTypes?: string[];
    } = {}
  ): { valid: boolean; error?: string } {
    const { maxSize = 10 * 1024 * 1024, allowedTypes = [] } = options;

    if (file.size > maxSize) {
      return {
        valid: false,
        error: `File size exceeds maximum of ${maxSize / 1024 / 1024}MB`,
      };
    }

    if (allowedTypes.length > 0 && !allowedTypes.includes(file.mimetype)) {
      return {
        valid: false,
        error: `File type ${file.mimetype} is not allowed`,
      };
    }

    return { valid: true };
  }
}
