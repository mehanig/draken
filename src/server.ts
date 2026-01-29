import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { getDb, closeDb } from './db/schema';
import { authMiddleware, validateAuthConfig } from './auth/middleware';
import { validateClaudeAuth } from './docker/manager';
import { initWebSocketServer } from './websocket/terminal';
import authRouter from './routes/auth';
import projectsRouter from './routes/projects';
import tasksRouter from './routes/tasks';
import browseRouter from './routes/browse';
import gitRouter from './routes/git';

const PORT = 40333;

// Validate configurations early - will throw if required vars are missing
try {
  // Validate Draken web auth (DRAKEN_USERNAME, DRAKEN_PASSWORD, DRAKEN_JWT_SECRET)
  validateAuthConfig();

  // Validate Claude auth (OAuth credentials or ANTHROPIC_API_KEY)
  validateClaudeAuth();
} catch (err) {
  console.error('\n' + (err as Error).message + '\n');
  process.exit(1);
}

const app = express();
const server = createServer(app);

// Initialize WebSocket server for terminal streaming
initWebSocketServer(server);

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

// Start server (using http server to support WebSocket upgrade)
server.listen(PORT, () => {
  console.log(`Draken dashboard running at http://localhost:${PORT}`);
});
