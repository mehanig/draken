import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  getTasksByProjectId,
  getTaskById,
  createTask,
  updateTaskStatus,
  updateTaskCompleted,
  appendTaskLogs,
  updateTaskSessionId,
} from '../db/queries';
import { getProjectById } from '../db/queries';
import { runTask, stopContainer, sendInputToTask, isTaskRunning } from '../docker/manager';
import { dockerfileExists } from '../docker/dockerfile';
import { CreateTaskRequest } from '../types';
import { getAuthConfig } from '../auth/middleware';

interface CreateFollowupRequest {
  prompt: string;
  parentTaskId: number;
}

const router = Router();

// Store active SSE connections for log streaming
const logSubscribers = new Map<number, Response[]>();

// Get tasks for a project
router.get('/project/:projectId', (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const tasks = getTasksByProjectId(projectId);
    res.json(tasks);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Get single task
router.get('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const task = getTaskById(id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task);
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// Create and run new task
router.post('/project/:projectId', async (req: Request, res: Response) => {
  try {
    const projectId = parseInt(req.params.projectId as string, 10);
    const { prompt } = req.body as CreateTaskRequest;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const project = getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check dockerfile exists
    if (!dockerfileExists(project.path)) {
      return res.status(400).json({ error: 'Dockerfile not found. Generate it first.' });
    }

    // Create task record
    const task = createTask(projectId, prompt.trim());

    // Start container in background
    setImmediate(async () => {
      try {
        updateTaskStatus(task.id, 'running');

        const { containerId, logEmitter } = await runTask(
          project.path,
          project.id,
          prompt.trim(),
          task.id
        );

        updateTaskStatus(task.id, 'running', containerId);

        logEmitter.on('log', (data: string) => {
          console.log('[task log received]', task.id, 'data length:', data.length, 'subscribers:', logSubscribers.get(task.id)?.length || 0);
          appendTaskLogs(task.id, data);

          // Broadcast to SSE subscribers
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'log', data })}\n\n`);
          });
        });

        logEmitter.on('session', (sessionId: string) => {
          // Save session ID for follow-up conversations
          updateTaskSessionId(task.id, sessionId);

          // Notify subscribers of session ID
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
          });
        });

        logEmitter.on('end', (exitCode: number) => {
          const status = exitCode === 0 ? 'completed' : 'failed';
          updateTaskCompleted(task.id, status);

          // Notify subscribers of completion
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'end', status, exitCode })}\n\n`);
            subscriber.end();
          });
          logSubscribers.delete(task.id);
        });

        logEmitter.on('error', (err: Error) => {
          console.error('Container error:', err);
          appendTaskLogs(task.id, `\nError: ${err.message}\n`);
          updateTaskCompleted(task.id, 'failed');

          // Notify subscribers of error
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            subscriber.end();
          });
          logSubscribers.delete(task.id);
        });
      } catch (err) {
        console.error('Error running task:', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        appendTaskLogs(task.id, `\nError: ${message}\n`);
        updateTaskCompleted(task.id, 'failed');
      }
    });

    res.status(201).json(task);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Create follow-up task (continues a previous conversation)
router.post('/:id/followup', async (req: Request, res: Response) => {
  try {
    const parentTaskId = parseInt(req.params.id as string, 10);
    const { prompt } = req.body as CreateTaskRequest;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const parentTask = getTaskById(parentTaskId);
    if (!parentTask) {
      return res.status(404).json({ error: 'Parent task not found' });
    }

    if (!parentTask.session_id) {
      return res.status(400).json({ error: 'Parent task has no session ID. Cannot follow up.' });
    }

    const project = getProjectById(parentTask.project_id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Create follow-up task
    const task = createTask(parentTask.project_id, prompt.trim(), parentTaskId);

    // Start container with --resume
    setImmediate(async () => {
      try {
        updateTaskStatus(task.id, 'running');

        const { containerId, logEmitter } = await runTask(
          project.path,
          project.id,
          prompt.trim(),
          task.id,
          parentTask.session_id!  // Resume the conversation
        );

        updateTaskStatus(task.id, 'running', containerId);

        logEmitter.on('log', (data: string) => {
          appendTaskLogs(task.id, data);
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'log', data })}\n\n`);
          });
        });

        logEmitter.on('session', (sessionId: string) => {
          updateTaskSessionId(task.id, sessionId);
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);
          });
        });

        logEmitter.on('end', (exitCode: number) => {
          const status = exitCode === 0 ? 'completed' : 'failed';
          updateTaskCompleted(task.id, status);
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'end', status, exitCode })}\n\n`);
            subscriber.end();
          });
          logSubscribers.delete(task.id);
        });

        logEmitter.on('error', (err: Error) => {
          console.error('Container error:', err);
          appendTaskLogs(task.id, `\nError: ${err.message}\n`);
          updateTaskCompleted(task.id, 'failed');
          const subscribers = logSubscribers.get(task.id) || [];
          subscribers.forEach(subscriber => {
            subscriber.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            subscriber.end();
          });
          logSubscribers.delete(task.id);
        });
      } catch (err) {
        console.error('Error running follow-up task:', err);
        const message = err instanceof Error ? err.message : 'Unknown error';
        appendTaskLogs(task.id, `\nError: ${message}\n`);
        updateTaskCompleted(task.id, 'failed');
      }
    });

    res.status(201).json(task);
  } catch (err) {
    console.error('Error creating follow-up task:', err);
    res.status(500).json({ error: 'Failed to create follow-up task' });
  }
});

// SSE endpoint for real-time logs
// Note: SSE doesn't support Authorization header, so we accept token via query param
router.get('/:id/logs', (req: Request, res: Response) => {
  const config = getAuthConfig();

  // If auth is enabled, verify token from query param
  if (config) {
    const token = req.query.token as string;
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      jwt.verify(token, config.jwtSecret);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  const id = parseInt(req.params.id as string, 10);
  const task = getTaskById(id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send existing logs first
  if (task.logs) {
    res.write(`data: ${JSON.stringify({ type: 'log', data: task.logs })}\n\n`);
  }

  // If task is already complete, send end event and close
  if (task.status === 'completed' || task.status === 'failed') {
    res.write(`data: ${JSON.stringify({ type: 'end', status: task.status })}\n\n`);
    res.end();
    return;
  }

  // Add to subscribers for live updates
  if (!logSubscribers.has(id)) {
    logSubscribers.set(id, []);
  }
  logSubscribers.get(id)!.push(res);
  console.log('[SSE] Subscriber added for task', id, 'total:', logSubscribers.get(id)!.length);

  // Clean up on disconnect
  req.on('close', () => {
    const subscribers = logSubscribers.get(id) || [];
    const index = subscribers.indexOf(res);
    if (index !== -1) {
      subscribers.splice(index, 1);
    }
  });
});

// Stop a running task
router.post('/:id/stop', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const task = getTaskById(id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'running' || !task.container_id) {
      return res.status(400).json({ error: 'Task is not running' });
    }

    await stopContainer(task.container_id);
    updateTaskCompleted(id, 'failed');
    appendTaskLogs(id, '\n[Task stopped by user]\n');

    res.json({ message: 'Task stopped' });
  } catch (err) {
    console.error('Error stopping task:', err);
    res.status(500).json({ error: 'Failed to stop task' });
  }
});

// Send input to a running task
router.post('/:id/input', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { input } = req.body;

    if (!input && input !== '') {
      return res.status(400).json({ error: 'Input is required' });
    }

    const task = getTaskById(id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'running') {
      return res.status(400).json({ error: 'Task is not running' });
    }

    if (!isTaskRunning(id)) {
      return res.status(400).json({ error: 'Task process not found' });
    }

    const sent = sendInputToTask(id, input);
    if (sent) {
      // Log the input for visibility
      appendTaskLogs(id, `\n> ${input}\n`);

      // Broadcast to SSE subscribers
      const subscribers = logSubscribers.get(id) || [];
      subscribers.forEach(subscriber => {
        subscriber.write(`data: ${JSON.stringify({ type: 'log', data: `\n> ${input}\n` })}\n\n`);
      });

      res.json({ message: 'Input sent' });
    } else {
      res.status(500).json({ error: 'Failed to send input' });
    }
  } catch (err) {
    console.error('Error sending input:', err);
    res.status(500).json({ error: 'Failed to send input' });
  }
});

export default router;
