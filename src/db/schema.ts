import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

/**
 * Get the draken data directory
 * Uses DRAKEN_DATA_DIR env var if set, otherwise ~/.draken
 * Works cross-platform (Windows, macOS, Linux)
 */
export function getDataDir(): string {
  if (process.env.DRAKEN_DATA_DIR) {
    return process.env.DRAKEN_DATA_DIR;
  }
  return path.join(os.homedir(), '.draken');
}

const DATA_DIR = getDataDir();
const DB_PATH = path.join(DATA_DIR, 'draken.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    
    console.log(`Database: ${DB_PATH}`);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      dockerfile_exists INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      container_id TEXT,
      logs TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);

  // Migration: Add session_id column if it doesn't exist
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT`);
  } catch { /* Column already exists */ }

  // Migration: Add parent_task_id column if it doesn't exist
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
  } catch { /* Column already exists */ }

  // Create index on session_id (after migration ensures column exists)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id)`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
