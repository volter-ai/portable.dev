import { promises as fs } from 'fs';
import path from 'path';

import { getUserWorkspaceDir } from '@vgit2/shared/constants';
import { Request, Response } from 'express';
import fsExtra from 'fs-extra';

import { HandlerDependencies } from '../types.js';
import { resolveRepoLocalPath } from '../utils/repoPathResolver.js';

export class ContentHandler {
  private deps: HandlerDependencies;

  constructor(deps: HandlerDependencies) {
    this.deps = deps;
  }

  /**
   * GET /api/repos/:owner/:repo/contents/*
   */
  async handleGetContents(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];

    const userId = req.session.userEmail!;

    try {
      const octokit = this.deps.getUserOctokit(userId);

      // rev9 D27: resolve the REAL on-disk path so a FLAT clone's files are served
      // locally too (not just the canonical two-level layout) — keeps the file viewer
      // consistent with the tree (handleGetTree). Falls back to the canonical path.
      const repoPath = await resolveRepoLocalPath(
        (req as any).gitLocalService,
        userId,
        owner,
        repo
      );
      const isLocal = await fsExtra.pathExists(repoPath);

      if (isLocal) {
        const fullPath = path.join(repoPath, filePath);

        if (!fullPath.startsWith(repoPath)) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }

        const exists = await fsExtra.pathExists(fullPath);
        if (!exists) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          res.status(400).json({ error: 'Path is a directory' });
          return;
        }

        const content = await fs.readFile(fullPath, 'utf-8');
        const base64Content = Buffer.from(content).toString('base64');

        const crypto = await import('crypto');
        const fileSize = Buffer.byteLength(content, 'utf-8');
        const blobContent = `blob ${fileSize}\0${content}`;
        const sha = crypto.createHash('sha1').update(blobContent).digest('hex');

        res.json({
          name: path.basename(filePath),
          path: filePath,
          content: base64Content,
          encoding: 'base64',
          size: stats.size,
          sha: sha,
          lastModified: stats.mtime.toISOString(),
        });
      } else {
        const { data } = await octokit.repos.getContent({
          owner,
          repo,
          path: filePath,
        });

        res.json(data);
      }
    } catch (error: any) {
      console.error('[ContentHandler] Error fetching file contents:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
      } else if (error.status === 404) {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch file contents' });
      }
    }
  }

  /**
   * GET /api/repos/:owner/:repo/raw/*
   */
  async handleGetRawContent(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];

    const userId = req.session.userEmail!;

    try {
      const octokit = this.deps.getUserOctokit(userId);

      // rev9 D27: resolve the REAL on-disk path so a FLAT clone's files are served
      // locally too (not just the canonical two-level layout) — keeps the file viewer
      // consistent with the tree (handleGetTree). Falls back to the canonical path.
      const repoPath = await resolveRepoLocalPath(
        (req as any).gitLocalService,
        userId,
        owner,
        repo
      );
      const isLocal = await fsExtra.pathExists(repoPath);

      if (isLocal) {
        const fullPath = path.join(repoPath, filePath);

        if (!fullPath.startsWith(repoPath)) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }

        const exists = await fsExtra.pathExists(fullPath);
        if (!exists) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          res.status(400).json({ error: 'Path is a directory' });
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.pdf': 'application/pdf',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
        };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', stats.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        const fileStream = fsExtra.createReadStream(fullPath);
        fileStream.pipe(res);
      } else {
        const { data } = await octokit.repos.getContent({
          owner,
          repo,
          path: filePath,
          mediaType: { format: 'raw' },
        });

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.pdf': 'application/pdf',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
        };
        const mimeType = mimeTypes[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(data);
      }
    } catch (error: any) {
      console.error('[ContentHandler] Error fetching raw file content:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
      } else if (error.status === 404) {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch raw file content' });
      }
    }
  }

  /**
   * PUT /api/repos/:owner/:repo/contents/*
   */
  async handleUpdateContents(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    const userId = req.session.userEmail!;

    try {
      // rev9 D27: resolve the REAL on-disk path (flat clone aware); canonical fallback.
      const repoPath = await resolveRepoLocalPath(
        (req as any).gitLocalService,
        userId,
        owner,
        repo
      );
      const isLocal = await fsExtra.pathExists(repoPath);

      if (!isLocal) {
        res
          .status(404)
          .json({ error: 'Repository not cloned locally. Clone it first to edit files.' });
        return;
      }

      const fullPath = path.join(repoPath, filePath);

      if (!fullPath.startsWith(repoPath)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      await fs.writeFile(fullPath, content, 'utf-8');

      const stats = await fs.stat(fullPath);
      const base64Content = Buffer.from(content).toString('base64');

      const crypto = await import('crypto');
      const fileSize = Buffer.byteLength(content, 'utf-8');
      const blobContent = `blob ${fileSize}\0${content}`;
      const sha = crypto.createHash('sha1').update(blobContent).digest('hex');

      res.json({
        name: path.basename(filePath),
        path: filePath,
        content: base64Content,
        encoding: 'base64',
        size: stats.size,
        sha: sha,
        message: 'File updated locally',
      });
    } catch (error: any) {
      console.error('[ContentHandler] Error updating local file:', error);
      res.status(500).json({ error: error.message || 'Failed to update local file' });
    }
  }

  /**
   * PUT /api/repos/:owner/:repo/github-contents/*
   */
  async handleUpdateGitHubContents(req: Request, res: Response): Promise<void> {
    if (!req.session.userEmail) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];
    const { content, message, sha } = req.body;

    if (!content) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }

    if (!message) {
      res.status(400).json({ error: 'Commit message is required' });
      return;
    }

    const userId = req.session.userEmail!;

    try {
      const octokit = this.deps.getUserOctokit(userId);
      const commitMessage = message;

      let base64Content = content;
      try {
        Buffer.from(content, 'base64').toString('utf-8');
        base64Content = content;
      } catch (e) {
        base64Content = Buffer.from(content).toString('base64');
      }

      const updateParams: any = {
        owner,
        repo,
        path: filePath,
        message: commitMessage,
        content: base64Content,
      };

      if (sha) {
        updateParams.sha = sha;
      }

      const { data } = await octokit.repos.createOrUpdateFileContents(updateParams);

      res.json({
        ...data,
        message: 'File updated on GitHub',
      });
    } catch (error: any) {
      console.error('[ContentHandler] Error updating file on GitHub:', error);
      if (error.status === 401) {
        req.session?.destroy?.((err) => {
          if (err) console.error('Error destroying session:', err);
        });
        res.status(401).json({ error: 'GitHub token expired. Please log in again.' });
      } else if (error.status === 404) {
        res.status(404).json({ error: 'File not found on GitHub' });
      } else if (error.status === 409) {
        res.status(409).json({ error: 'File SHA mismatch. Please refresh and try again.' });
      } else {
        res.status(500).json({ error: error.message || 'Failed to update file on GitHub' });
      }
    }
  }

  /**
   * GET /api/video/:owner/:repo/*
   */
  async handleServeVideo(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const userWorkspace = getUserWorkspaceDir(userId);

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];

    let fullPath: string;
    if (owner === '_workspace' && repo === '_temp') {
      fullPath = path.join(userWorkspace, 'sent-videos', filePath);
    } else {
      fullPath = path.join(userWorkspace, owner, repo, filePath);
    }

    try {
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(userWorkspace))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      await fs.access(resolvedPath);

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType =
        ext === '.webm' ? 'video/webm' : ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';

      res.setHeader('Content-Type', contentType);

      res.sendFile(resolvedPath, (err) => {
        if (err) {
          console.error('[ContentHandler] Error serving video:', {
            url: req.url,
            path: resolvedPath,
            owner,
            repo,
            error: err.message,
            errorType: err.name,
            statusCode: (err as any).status || (err as any).statusCode,
          });
          if (!res.headersSent) {
            res.status((err as any).status || 500).end();
          }
        }
      });
    } catch (error) {
      console.error('[ContentHandler] Video file access error:', {
        requestedPath: fullPath,
        error: error instanceof Error ? error.message : error,
      });
      res.status(404).json({ error: 'Video file not found' });
    }
  }

  /**
   * GET /api/image/:owner/:repo/*
   */
  async handleServeImage(req: Request, res: Response): Promise<void> {
    const userId = req.session.userEmail!;
    const userWorkspace = getUserWorkspaceDir(userId);

    const { owner, repo } = req.params as { owner: string; repo: string };
    const filePath = req.params[0];

    let fullPath: string;
    if (owner === '_workspace' && repo === '_temp') {
      fullPath = path.join(userWorkspace, 'temp', filePath);
    } else {
      fullPath = path.join(userWorkspace, owner, repo, filePath);
    }

    try {
      const resolvedPath = path.resolve(fullPath);
      if (!resolvedPath.startsWith(path.resolve(userWorkspace))) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      await fs.access(resolvedPath);

      const ext = path.extname(resolvedPath).toLowerCase();
      const contentType =
        ext === '.webp'
          ? 'image/webp'
          : ext === '.png'
            ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg'
              ? 'image/jpeg'
              : ext === '.gif'
                ? 'image/gif'
                : 'application/octet-stream';

      res.setHeader('Content-Type', contentType);

      res.sendFile(resolvedPath, (err) => {
        if (err) {
          console.error('[ContentHandler] Error serving image:', {
            url: req.url,
            path: resolvedPath,
            owner,
            repo,
            error: err.message,
            errorType: err.name,
            statusCode: (err as any).status || (err as any).statusCode,
          });
          if (!res.headersSent) {
            res.status((err as any).status || 500).end();
          }
        }
      });
    } catch (error) {
      console.error('[ContentHandler] Image file access error:', {
        requestedPath: fullPath,
        error: error instanceof Error ? error.message : error,
      });
      res.status(404).json({ error: 'Image file not found' });
    }
  }
}
