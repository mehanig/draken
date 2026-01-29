import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getProjectById } from '../db/queries';
import { getProjectMounts, MountConfig } from '../docker/dockerfile';
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
  isGitRepo,
  GitStatus,
} from '../git/status';

const router = Router();

// Max file size to read (100KB)
const MAX_FILE_SIZE = 100 * 1024;

/**
 * Helper to get repo paths for a project
 * Returns array of { alias, path } for all mounts, or single entry with project path
 */
function getRepoPaths(projectPath: string): MountConfig[] {
  const mounts = getProjectMounts(projectPath);
  if (mounts.length > 0) {
    return mounts;
  }
  // Backward compatibility: single repo mode
  return [{ alias: 'main', path: projectPath }];
}

/**
 * Helper to resolve repo path from project and optional mount alias
 */
function resolveRepoPath(projectPath: string, mountAlias?: string): string {
  const mounts = getProjectMounts(projectPath);

  if (mounts.length === 0) {
    // Single repo mode - always use project path
    return projectPath;
  }

  if (!mountAlias) {
    // Multi-repo mode but no alias specified - default to first mount
    return mounts[0].path;
  }

  const mount = mounts.find(m => m.alias === mountAlias);
  if (!mount) {
    throw new Error(`Mount "${mountAlias}" not found`);
  }

  return mount.path;
}

export interface MultiRepoGitStatus {
  mount: string;
  path: string;
  status: GitStatus;
}

// Get git status for all repos in a project
router.get('/:projectId/status', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const mountAlias = req.query.mount as string | undefined;
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const mounts = getRepoPaths(project.path);
    
    // If specific mount requested, return only that
    if (mountAlias) {
      const mount = mounts.find(m => m.alias === mountAlias);
      if (!mount) {
        return res.status(404).json({ error: `Mount "${mountAlias}" not found` });
      }
      const status = await getGitStatus(mount.path);
      return res.json(status);
    }

    // Return status for all mounts
    const results: MultiRepoGitStatus[] = await Promise.all(
      mounts.map(async (mount) => ({
        mount: mount.alias,
        path: mount.path,
        status: await getGitStatus(mount.path),
      }))
    );

    // For backward compatibility, if single repo, return just the status
    if (results.length === 1 && mounts[0].alias === 'main' && getProjectMounts(project.path).length === 0) {
      return res.json(results[0].status);
    }

    res.json(results);
  } catch (err) {
    console.error('Error getting git status:', err);
    res.status(500).json({ error: 'Failed to get git status' });
  }
});

// Get git diff for a project/mount
router.get('/:projectId/diff', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const staged = req.query.staged === 'true';
    const mountAlias = req.query.mount as string | undefined;
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    const diff = await getGitDiff(repoPath, staged);
    res.json({ diff });
  } catch (err) {
    console.error('Error getting git diff:', err);
    const message = err instanceof Error ? err.message : 'Failed to get git diff';
    res.status(500).json({ error: message });
  }
});

// Get both staged and unstaged diffs
router.get('/:projectId/diffs', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const mountAlias = req.query.mount as string | undefined;
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    const diffs = await getGitDiffs(repoPath);
    res.json(diffs);
  } catch (err) {
    console.error('Error getting git diffs:', err);
    const message = err instanceof Error ? err.message : 'Failed to get git diffs';
    res.status(500).json({ error: message });
  }
});

// Get old/new content for file diff comparison
router.get('/:projectId/file-diff', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const filePath = req.query.path as string;
    const staged = req.query.staged === 'true';
    const mountAlias = req.query.mount as string | undefined;

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);

    // Prevent path traversal
    const fullPath = path.join(repoPath, filePath);
    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const diffContent = await getFileDiffContent(repoPath, filePath, staged);
    res.json(diffContent);
  } catch (err) {
    console.error('Error getting file diff content:', err);
    const message = err instanceof Error ? err.message : 'Failed to get file diff content';
    res.status(500).json({ error: message });
  }
});

// Get content of a specific file (for untracked files)
router.get('/:projectId/file', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const filePath = req.query.path as string;
    const mountAlias = req.query.mount as string | undefined;

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);

    // Prevent path traversal
    const fullPath = path.join(repoPath, filePath);
    if (!fullPath.startsWith(repoPath)) {
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
    const message = err instanceof Error ? err.message : 'Failed to read file';
    res.status(500).json({ error: message });
  }
});

// List all branches
router.get('/:projectId/branches', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const mountAlias = req.query.mount as string | undefined;
    const project = getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    const branches = await listBranches(repoPath);
    res.json(branches);
  } catch (err) {
    console.error('Error listing branches:', err);
    const message = err instanceof Error ? err.message : 'Failed to list branches';
    res.status(500).json({ error: message });
  }
});

// Create a new branch
router.post('/:projectId/branch', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { name, checkout = true, mount: mountAlias } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    await createBranch(repoPath, name, checkout);
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
    const { branch, mount: mountAlias } = req.body;

    if (!branch) {
      return res.status(400).json({ error: 'Branch name is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    await checkoutBranch(repoPath, branch);
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
    const { files, all = false, mount: mountAlias } = req.body;

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);

    if (all) {
      await stageAll(repoPath);
    } else if (files && files.length > 0) {
      await stageFiles(repoPath, files);
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
    const { files, all = false, mount: mountAlias } = req.body;

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);

    if (all) {
      await unstageAll(repoPath);
    } else if (files && files.length > 0) {
      await unstageFiles(repoPath, files);
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
    const { message, mount: mountAlias } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Commit message is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const repoPath = resolveRepoPath(project.path, mountAlias);
    const result = await commit(repoPath, message);
    res.json(result);
  } catch (err) {
    console.error('Error committing:', err);
    const message = err instanceof Error ? err.message : 'Failed to commit';
    res.status(500).json({ error: message });
  }
});

export default router;
