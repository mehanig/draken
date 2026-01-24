export interface Project {
  id: number;
  name: string;
  path: string;
  dockerfile_exists: number;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  container_id: string | null;
  logs: string | null;
  session_id: string | null;
  parent_task_id: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  entries: DirectoryEntry[];
}

export interface DockerfileStatus {
  exists: boolean;
  path?: string;
}

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
