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
  created_at: string;
  completed_at: string | null;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
}

export interface CreateTaskRequest {
  prompt: string;
}
