import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getProjectById } from '../db/queries';
import {
  getGitStatus,
  getGitDiffs,
  getGitDiff,
  getFileDiffContent,
  listBranches,
  createBranch,
  checkoutBranch,
  stageFiles,
  stageAll,
  unstageFiles,
  unstageAll,
  commit,
} from '../git/status';

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

// List all branches
router.get('/:projectId/branches', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const branches = await listBranches(project.path);
    res.json(branches);
  } catch (err) {
    console.error('Error listing branches:', err);
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

// Create a new branch
router.post('/:projectId/branch', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { name, checkout = true } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await createBranch(project.path, name, checkout);
    res.json({ success: true, branch: name });
  } catch (err) {
    console.error('Error creating branch:', err);
    const message = err instanceof Error ? err.message : 'Failed to create branch';
    res.status(500).json({ error: message });
  }
});

// Checkout a branch
router.post('/:projectId/checkout', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { branch } = req.body;

    if (!branch) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await checkoutBranch(project.path, branch);
    res.json({ success: true, branch });
  } catch (err) {
    console.error('Error checking out branch:', err);
    const message = err instanceof Error ? err.message : 'Failed to checkout branch';
    res.status(500).json({ error: message });
  }
});

// Stage files
router.post('/:projectId/stage', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { files, all = false } = req.body;

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (all) {
      await stageAll(project.path);
    } else if (files && files.length > 0) {
      await stageFiles(project.path, files);
    } else {
      return res.status(400).json({ error: 'No files specified' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error staging files:', err);
    const message = err instanceof Error ? err.message : 'Failed to stage files';
    res.status(500).json({ error: message });
  }
});

// Unstage files
router.post('/:projectId/unstage', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { files, all = false } = req.body;

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (all) {
      await unstageAll(project.path);
    } else if (files && files.length > 0) {
      await unstageFiles(project.path, files);
    } else {
      return res.status(400).json({ error: 'No files specified' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error unstaging files:', err);
    const message = err instanceof Error ? err.message : 'Failed to unstage files';
    res.status(500).json({ error: message });
  }
});

// Commit staged changes
router.post('/:projectId/commit', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Commit message is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const result = await commit(project.path, message);
    res.json(result);
  } catch (err) {
    console.error('Error committing:', err);
    const message = err instanceof Error ? err.message : 'Failed to commit';
    res.status(500).json({ error: message });
  }
});

export default router;
