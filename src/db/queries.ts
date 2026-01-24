import { getDb } from './schema';
import { Project, Task } from '../types';

// Project queries
export function getAllProjects(): Project[] {
  const db = getDb();
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Project[];
}

export function getProjectById(id: number): Project | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function createProject(name: string, path: string): Project {
  const db = getDb();
  const result = db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(name, path);
  return getProjectById(result.lastInsertRowid as number)!;
}

export function deleteProject(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateProjectDockerfileStatus(id: number, exists: boolean): void {
  const db = getDb();
  db.prepare('UPDATE projects SET dockerfile_exists = ? WHERE id = ?').run(exists ? 1 : 0, id);
}

// Task queries
export function getTasksByProjectId(projectId: number): Task[] {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Task[];
}

export function getTaskById(id: number): Task | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function createTask(projectId: number, prompt: string, parentTaskId?: number): Task {
  const db = getDb();
  const result = db.prepare('INSERT INTO tasks (project_id, prompt, status, parent_task_id) VALUES (?, ?, ?, ?)').run(projectId, prompt, 'pending', parentTaskId || null);
  return getTaskById(result.lastInsertRowid as number)!;
}

export function updateTaskSessionId(id: number, sessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, id);
}

export function getLatestTaskWithSession(projectId: number): Task | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE project_id = ? AND session_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId) as Task | undefined;
}

export function updateTaskStatus(id: number, status: Task['status'], containerId?: string): void {
  const db = getDb();
  if (containerId) {
    db.prepare('UPDATE tasks SET status = ?, container_id = ? WHERE id = ?').run(status, containerId, id);
  } else {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
  }
}

export function updateTaskCompleted(id: number, status: Task['status']): void {
  const db = getDb();
  db.prepare('UPDATE tasks SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
}

export function appendTaskLogs(id: number, newLogs: string): void {
  const db = getDb();
  const task = getTaskById(id);
  const currentLogs = task?.logs || '';
  db.prepare('UPDATE tasks SET logs = ? WHERE id = ?').run(currentLogs + newLogs, id);
}

export function getRunningTasks(): Task[] {
  const db = getDb();
  return db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as Task[];
}
