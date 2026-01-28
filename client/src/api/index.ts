import type { Project, Task, BrowseResponse, DockerfileStatus, GitStatus, GitDiff } from '../types';

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

// Git API
export async function getGitStatus(projectId: number): Promise<GitStatus> {
  const response = await fetch(`${API_BASE}/git/${projectId}/status`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<GitStatus>(response);
}

export async function getGitDiff(projectId: number, staged: boolean = false): Promise<string> {
  const url = `${API_BASE}/git/${projectId}/diff${staged ? '?staged=true' : ''}`;
  const response = await fetch(url, {
    headers: getAuthHeaders(),
  });
  const data = await handleResponse<{ diff: string }>(response);
  return data.diff;
}

export async function getGitDiffs(projectId: number): Promise<GitDiff> {
  const response = await fetch(`${API_BASE}/git/${projectId}/diffs`, {
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

export async function getFileContent(projectId: number, filePath: string): Promise<FileContentResponse> {
  const url = `${API_BASE}/git/${projectId}/file?path=${encodeURIComponent(filePath)}`;
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
  staged: boolean
): Promise<FileDiffContentResponse> {
  const url = `${API_BASE}/git/${projectId}/file-diff?path=${encodeURIComponent(filePath)}&staged=${staged}`;
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

export async function getBranches(projectId: number): Promise<GitBranch[]> {
  const response = await fetch(`${API_BASE}/git/${projectId}/branches`, {
    headers: getAuthHeaders(),
  });
  return handleResponse<GitBranch[]>(response);
}

export async function createBranch(projectId: number, name: string, checkout: boolean = true): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/branch`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ name, checkout }),
  });
  return handleVoidResponse(response);
}

export async function checkoutBranch(projectId: number, branch: string): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/checkout`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ branch }),
  });
  return handleVoidResponse(response);
}

// Git staging operations
export async function stageFiles(projectId: number, files: string[]): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/stage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ files }),
  });
  return handleVoidResponse(response);
}

export async function stageAll(projectId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/stage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ all: true }),
  });
  return handleVoidResponse(response);
}

export async function unstageFiles(projectId: number, files: string[]): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/unstage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ files }),
  });
  return handleVoidResponse(response);
}

export async function unstageAll(projectId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/git/${projectId}/unstage`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ all: true }),
  });
  return handleVoidResponse(response);
}

// Git commit
export interface CommitResult {
  hash: string;
  message: string;
}

export async function commitChanges(projectId: number, message: string): Promise<CommitResult> {
  const response = await fetch(`${API_BASE}/git/${projectId}/commit`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({ message }),
  });
  return handleResponse<CommitResult>(response);
}
