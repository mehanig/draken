import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getProjectById } from '../db/queries';
import { getGitStatus, getGitDiffs, getGitDiff, getFileDiffContent } from '../git/status';

const router = Router();

// Max file size to read (100KB)
const MAX_FILE_SIZE = 100 * 1024;

// Get git status for a project
router.get('/:projectId/status', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const status = await getGitStatus(project.path);
    res.json(status);
  } catch (err) {
    console.error('Error getting git status:', err);
    res.status(500).json({ error: 'Failed to get git status' });
  }
});

// Get git diff for a project
router.get('/:projectId/diff', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const staged = req.query.staged === 'true';
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const diff = await getGitDiff(project.path, staged);
    res.json({ diff });
  } catch (err) {
    console.error('Error getting git diff:', err);
    res.status(500).json({ error: 'Failed to get git diff' });
  }
});

// Get both staged and unstaged diffs
router.get('/:projectId/diffs', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const diffs = await getGitDiffs(project.path);
    res.json(diffs);
  } catch (err) {
    console.error('Error getting git diffs:', err);
    res.status(500).json({ error: 'Failed to get git diffs' });
  }
});

// Get old/new content for file diff comparison
router.get('/:projectId/file-diff', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const filePath = req.query.path as string;
    const staged = req.query.staged === 'true';

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Prevent path traversal
    const fullPath = path.join(project.path, filePath);
    if (!fullPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const diffContent = await getFileDiffContent(project.path, filePath, staged);
    res.json(diffContent);
  } catch (err) {
    console.error('Error getting file diff content:', err);
    res.status(500).json({ error: 'Failed to get file diff content' });
  }
});

// Get content of a specific file (for untracked files)
router.get('/:projectId/file', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const filePath = req.query.path as string;

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Prevent path traversal
    const fullPath = path.join(project.path, filePath);
    if (!fullPath.startsWith(project.path)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if file exists and is not too large
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return res.json({ content: null, isDirectory: true });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return res.json({ content: null, tooLarge: true, size: stat.size });
    }

    // Check if it's a binary file (simple heuristic)
    const buffer = Buffer.alloc(512);
    const fd = fs.openSync(fullPath, 'r');
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    const isBinary = buffer.includes(0);
    if (isBinary) {
      return res.json({ content: null, isBinary: true });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ content });
  } catch (err) {
    console.error('Error reading file:', err);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

export default router;
