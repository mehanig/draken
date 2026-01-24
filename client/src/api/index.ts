import type { Project, Task, BrowseResponse, DockerfileStatus } from '../types';

const API_BASE = '/api';

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE}/projects`);
  if (!response.ok) throw new Error('Failed to fetch projects');
  return response.json();
}

export async function createProject(path: string): Promise<Project> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new Error('Failed to create project');
  return response.json();
}

export async function deleteProject(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete project');
}

export async function getDockerfileStatus(projectId: number): Promise<DockerfileStatus> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/dockerfile`);
  if (!response.ok) throw new Error('Failed to get dockerfile status');
  return response.json();
}

export async function generateDockerfile(projectId: number): Promise<DockerfileStatus> {
  const response = await fetch(`${API_BASE}/projects/${projectId}/generate-dockerfile`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to generate dockerfile');
  return response.json();
}

export async function fetchTasks(projectId: number): Promise<Task[]> {
  const response = await fetch(`${API_BASE}/tasks/project/${projectId}`);
  if (!response.ok) throw new Error('Failed to fetch tasks');
  return response.json();
}

export async function createTask(projectId: number, prompt: string): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/project/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error('Failed to create task');
  return response.json();
}

export async function stopTask(taskId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/stop`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to stop task');
}

export async function createFollowupTask(parentTaskId: number, prompt: string): Promise<Task> {
  const response = await fetch(`${API_BASE}/tasks/${parentTaskId}/followup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error('Failed to create followup task');
  return response.json();
}

export async function browsePath(path?: string): Promise<BrowseResponse> {
  const url = path ? `${API_BASE}/browse?path=${encodeURIComponent(path)}` : `${API_BASE}/browse`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to browse directory');
  return response.json();
}
