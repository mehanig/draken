import express from 'express';
import path from 'path';
import { getDb, closeDb } from './db/schema';
import { authMiddleware, isAuthEnabled } from './auth/middleware';
import authRouter from './routes/auth';
import projectsRouter from './routes/projects';
import tasksRouter from './routes/tasks';
import browseRouter from './routes/browse';
import gitRouter from './routes/git';

const PORT = 40333;
const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth routes (public - no auth required)
app.use('/api/auth', authRouter);

// Protected API Routes (auth required if configured)
app.use('/api/projects', authMiddleware, projectsRouter);
app.use('/api/tasks', authMiddleware, tasksRouter);
app.use('/api/browse', authMiddleware, browseRouter);
app.use('/api/git', authMiddleware, gitRouter);

// Client-side routing - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

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

  if (isAuthEnabled()) {
    console.log('Authentication: ENABLED');
  } else {
    console.warn('Warning: Authentication is DISABLED. Set DRAKEN_USERNAME and DRAKEN_PASSWORD to enable.');
  }
});
