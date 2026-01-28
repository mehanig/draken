import type { Project, Task, BrowseResponse, DockerfileStatus, GitStatus, GitDiff, MountConfig, MultiRepoGitStatus } from '../types';

const API_BASE = '/api';

// Get auth token from localStorage
function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('draken_token');
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

// Handle API response with auth error detection
async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    // Token expired or invalid - clear and redirect
    localStorage.removeItem('draken_token');
    localStorage.removeItem('draken_username');
    window.location.reload();
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

// Handle void responses (204 No Content)
async function handleVoidResponse(response: Response): Promise<void> {
  if (response.status === 401) {
    localStorage.removeItem('draken_token');
    localStorage.removeItem('draken_username');
    window.location.reload();
    throw new Error('Authentication required');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
}

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/projects`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<Project[]>(response);
}

export async function createProject(path: string): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path }),
  });
  return handleResponse<Project>(response);
}

export async function deleteProject(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleVoidResponse(response);
}

export async function getDockerfileStatus(projectId: number): Promise<DockerfileStatus> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/dockerfile`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<DockerfileStatus>(response);
}

export async function generateDockerfile(projectId: number): Promise<DockerfileStatus> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/generate-dockerfile`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleResponse<DockerfileStatus>(response);
}

// Mount management
export async function getProjectMounts(projectId: number): Promise<MountConfig[]> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/mounts`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<MountConfig[]>(response);
}

export async function addProjectMount(projectId: number, path: string, alias?: string): Promise<MountConfig[]> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/mounts`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ path, alias }),
  });
  return handleResponse<MountConfig[]>(response);
}

export async function removeProjectMount(projectId: number, alias: string): Promise<MountConfig[]> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/mounts/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  return handleResponse<MountConfig[]>(response);
}

export async function fetchTasks(projectId: number): Promise<Task[]> {
  const response = await fetch(`${API_BASE}/tasks/project/${projectId}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<Task[]>(response);
}

export async function createTask(projectId: number, prompt: string): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/project/${projectId}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ prompt }),
  });
  return handleResponse<Task>(response);
}

export async function stopTask(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/stop`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  return handleVoidResponse(response);
}

export async function createFollowupTask(parentTaskId: number, prompt: string): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/${parentTaskId}/followup`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ prompt }),
  });
  return handleResponse<Task>(response);
}

export async function browsePath(path?: string): Promise<BrowseResponse> {
  const url = path ? `${API_BASE}/browse?path=${encodeURIComponent(path)}` : `${API_BASE}/browse`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  return handleResponse<BrowseResponse>(response);
}

// Export helper for SSE connections that need auth
export function getAuthToken(): string | null {
  return localStorage.getItem('draken_token');
}

// Git API - supports both single and multi-repo projects
export async function getGitStatus(projectId: number, mount?: string): Promise<GitStatus | MultiRepoGitStatus[]> {
  const params = mount ? `?mount=${encodeURIComponent(mount)}` : '';
  const response = await fetch(`${API_BASE}/git/${projectId}/status${params}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<GitStatus | MultiRepoGitStatus[]>(response);
}

export async function getGitDiff(projectId: number, staged: boolean = false, mount?: string): Promise<string> {
  const params = new URLSearchParams();
  if (staged) params.set('staged', 'true');
  if (mount) params.set('mount', mount);
  const url = `${API_BASE}/git/${projectId}/diff${params.toString() ? '?' + params.toString() : ''}`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ diff: string }>(response);
  return data.diff;
}

export async function getGitDiffs(projectId: number, mount?: string): Promise<GitDiff> {
  const params = mount ? `?mount=${encodeURIComponent(mount)}` : '';
  const response = await fetch(`${API_BASE}/git/${projectId}/diffs${params}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<GitDiff>(response);
}

export interface FileContentResponse {
  content: string | null;
  isDirectory?: boolean;
  isBinary?: boolean;
  tooLarge?: boolean;
  size?: number;
}

export async function getFileContent(projectId: number, filePath: string, mount?: string): Promise<FileContentResponse> {
  const params = new URLSearchParams({ path: filePath });
  if (mount) params.set('mount', mount);
  const url = `${API_BASE}/git/${projectId}/file?${params.toString()}`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  return handleResponse<FileContentResponse>(response);
}

export interface FileDiffContentResponse {
  oldContent: string;
  newContent: string;
  oldFileName: string;
  newFileName: string;
}

export async function getFileDiffContent(
  projectId: number,
  filePath: string,
  staged: boolean,
  mount?: string
): Promise<FileDiffContentResponse> {
  const params = new URLSearchParams({ path: filePath, staged: String(staged) });
  if (mount) params.set('mount', mount);
  const url = `${API_BASE}/git/${projectId}/file-diff?${params.toString()}`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  return handleResponse<FileDiffContentResponse>(response);
}

// Git branch operations
export interface GitBranch {
  name: string;
  current: boolean;
}

export async function getBranches(projectId: number, mount?: string): Promise<GitBranch[]> {
  const params = mount ? `?mount=${encodeURIComponent(mount)}` : '';
  const response = await fetch(`${API_BASE}/git/${projectId}/branches${params}`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<GitBranch[]>(response);
}

export async function createBranch(projectId: number, name: string, checkout: boolean = true, mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/branch`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name, checkout, mount }),
  });
  return handleVoidResponse(response);
}

export async function checkoutBranch(projectId: number, branch: string, mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/checkout`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ branch, mount }),
  });
  return handleVoidResponse(response);
}

// Git staging operations
export async function stageFiles(projectId: number, files: string[], mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/stage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ files, mount }),
  });
  return handleVoidResponse(response);
}

export async function stageAll(projectId: number, mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/stage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ all: true, mount }),
  });
  return handleVoidResponse(response);
}

export async function unstageFiles(projectId: number, files: string[], mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/unstage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ files, mount }),
  });
  return handleVoidResponse(response);
}

export async function unstageAll(projectId: number, mount?: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/unstage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ all: true, mount }),
  });
  return handleVoidResponse(response);
}

// Git commit
export interface CommitResult {
  hash: string;
  message: string;
}

export async function commitChanges(projectId: number, message: string, mount?: string): Promise<CommitResult> {
  const response = await fetch(`${API_BASE}/git/${projectId}/commit`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ message, mount }),
  });
  return handleResponse<CommitResult>(response);
}
