import express from 'express';
import path from 'path';
import { getDb, closeDb } from './db/schema';
import projectsRouter from './routes/projects';
import tasksRouter from './routes/tasks';
import browseRouter from './routes/browse';

const PORT = 40333;
const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/projects', projectsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/browse', browseRouter);

// Initialize database
getDb();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  closeDb();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Draken dashboard running at http://localhost:${PORT}`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('Warning: ANTHROPIC_API_KEY environment variable is not set');
  }
});
