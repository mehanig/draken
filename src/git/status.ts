import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import path from 'path';
import fs from 'fs';

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
}

export interface GitDiff {
  staged: string;
  unstaged: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface CommitResult {
  hash: string;
  message: string;
}

export function isGitRepo(projectPath: string): boolean {
  try {
    const gitDir = path.join(projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      return false;
    }
    // Check if it's a directory (normal repo) or file (worktree/submodule)
    const stat = fs.statSync(gitDir);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function createGit(projectPath: string): SimpleGit {
  return simpleGit(projectPath, { binary: 'git', maxConcurrentProcesses: 6 });
}

/**
 * List all local branches
 */
export async function listBranches(projectPath: string): Promise<GitBranch[]> {
  if (!isGitRepo(projectPath)) {
    return [];
  }

  try {
    const git = createGit(projectPath);
    const branchSummary = await git.branchLocal();
    
    return branchSummary.all.map(name => ({
      name,
      current: name === branchSummary.current,
    }));
  } catch {
    // Not a valid git repo - return empty
    return [];
  }
}

/**
 * Create a new branch
 */
export async function createBranch(projectPath: string, branchName: string, checkout: boolean = true): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  
  if (checkout) {
    await git.checkoutLocalBranch(branchName);
  } else {
    await git.branch([branchName]);
  }
}

/**
 * Checkout an existing branch
 */
export async function checkoutBranch(projectPath: string, branchName: string): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  await git.checkout(branchName);
}

/**
 * Stage files for commit
 */
export async function stageFiles(projectPath: string, files: string[]): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  await git.add(files);
}

/**
 * Stage all changes
 */
export async function stageAll(projectPath: string): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  await git.add('-A');
}

/**
 * Unstage files
 */
export async function unstageFiles(projectPath: string, files: string[]): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  await git.reset(['HEAD', '--', ...files]);
}

/**
 * Unstage all files
 */
export async function unstageAll(projectPath: string): Promise<void> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  const git = createGit(projectPath);
  await git.reset(['HEAD']);
}

/**
 * Commit staged changes
 */
export async function commit(projectPath: string, message: string): Promise<CommitResult> {
  if (!isGitRepo(projectPath)) {
    throw new Error('Not a git repository');
  }

  if (!message.trim()) {
    throw new Error('Commit message cannot be empty');
  }

  const git = createGit(projectPath);
  const result = await git.commit(message);
  
  return {
    hash: result.commit,
    message: message,
  };
}

export async function getGitStatus(projectPath: string): Promise<GitStatus> {
  if (!isGitRepo(projectPath)) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
    };
  }

  try {
    const git = createGit(projectPath);
    const status: StatusResult = await git.status();

    const changes: GitFileChange[] = [];

    // Staged files
    for (const file of status.staged) {
      changes.push({
        path: file,
        status: 'added',
        staged: true,
      });
    }

    // Modified and staged
    for (const file of status.modified) {
      // Check if it's staged or not by looking at other arrays
      const isStaged = !status.files.some(f => f.path === file && f.working_dir !== ' ');
      if (isStaged) {
        changes.push({
          path: file,
          status: 'modified',
          staged: true,
        });
      }
    }

    // Use the files array for accurate staged/unstaged detection
    for (const file of status.files) {
      // Index status (staged)
      if (file.index && file.index !== ' ' && file.index !== '?') {
        // Check if not already added
        const exists = changes.some(c => c.path === file.path && c.staged);
        if (!exists) {
          changes.push({
            path: file.path,
            status: mapStatusChar(file.index),
            staged: true,
          });
        }
      }

      // Working directory status (unstaged)
      if (file.working_dir && file.working_dir !== ' ') {
        if (file.working_dir === '?') {
          changes.push({
            path: file.path,
            status: 'untracked',
            staged: false,
          });
        } else {
          changes.push({
            path: file.path,
            status: mapStatusChar(file.working_dir),
            staged: false,
          });
        }
      }
    }

    // Deduplicate changes (in case of overlap)
    const uniqueChanges = changes.filter((change, index, self) =>
      index === self.findIndex(c => c.path === change.path && c.staged === change.staged)
    );

    const hasUncommittedChanges = uniqueChanges.some(c => c.status !== 'untracked');
    const hasUntrackedFiles = uniqueChanges.some(c => c.status === 'untracked');

    return {
      isRepo: true,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind,
      changes: uniqueChanges,
      hasUncommittedChanges,
      hasUntrackedFiles,
    };
  } catch {
    // Not a valid git repo or git error - return as non-repo
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      changes: [],
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
    };
  }
}

export async function getGitDiff(projectPath: string, staged: boolean = false): Promise<string> {
  if (!isGitRepo(projectPath)) {
    return '';
  }

  try {
    const git = createGit(projectPath);
    const options = staged ? ['--cached'] : [];
    return await git.diff(options);
  } catch {
    return '';
  }
}

export async function getGitDiffs(projectPath: string): Promise<GitDiff> {
  const [staged, unstaged] = await Promise.all([
    getGitDiff(projectPath, true),
    getGitDiff(projectPath, false),
  ]);

  return { staged, unstaged };
}

function mapStatusChar(char: string): GitFileChange['status'] {
  switch (char) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case '?': return 'untracked';
    default: return 'modified';
  }
}

export interface FileDiffContent {
  oldContent: string;
  newContent: string;
  oldFileName: string;
  newFileName: string;
}

/**
 * Get old and new content for a file to display a diff
 * @param projectPath - Path to the git repository
 * @param filePath - Path to the file relative to repo root
 * @param staged - Whether the file is staged or unstaged
 */
export async function getFileDiffContent(
  projectPath: string,
  filePath: string,
  staged: boolean
): Promise<FileDiffContent> {
  const git = createGit(projectPath);
  const fullPath = path.join(projectPath, filePath);

  let oldContent = '';
  let newContent = '';

  try {
    if (staged) {
      // Staged changes: compare HEAD to staged (index)
      // Old = committed version (HEAD)
      // New = staged version (index)
      try {
        oldContent = await git.show([`HEAD:${filePath}`]);
      } catch {
        // File might be newly added (no HEAD version)
        oldContent = '';
      }

      try {
        newContent = await git.show([`:${filePath}`]);
      } catch {
        // Fallback to reading from disk
        if (fs.existsSync(fullPath)) {
          newContent = fs.readFileSync(fullPath, 'utf-8');
        }
      }
    } else {
      // Unstaged changes: compare index/HEAD to working directory
      // Old = staged version (index) or committed version (HEAD)
      // New = current file on disk
      try {
        // Try to get from index first (staged version)
        oldContent = await git.show([`:${filePath}`]);
      } catch {
        try {
          // Fall back to HEAD
          oldContent = await git.show([`HEAD:${filePath}`]);
        } catch {
          oldContent = '';
        }
      }

      // New content is the current file on disk
      if (fs.existsSync(fullPath)) {
        newContent = fs.readFileSync(fullPath, 'utf-8');
      }
    }
  } catch {
    // Git error - return empty content
  }

  return {
    oldContent,
    newContent,
    oldFileName: filePath,
    newFileName: filePath,
  };
}
