import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer, IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { getAuthConfig } from '../auth/middleware';
import { URL } from 'url';

// WebSocket message types
export interface TerminalOutputMessage {
  type: 'output';
  data: string;
}

export interface TerminalSessionMessage {
  type: 'session';
  sessionId: string;
}

export interface TerminalEndMessage {
  type: 'end';
  status: string;
  exitCode: number;
}

export interface TerminalErrorMessage {
  type: 'error';
  message: string;
}

export type TerminalMessage =
  | TerminalOutputMessage
  | TerminalSessionMessage
  | TerminalEndMessage
  | TerminalErrorMessage;

// Track WebSocket clients per taskId
const taskClients = new Map<number, Set<WebSocket>>();

/**
 * Initialize WebSocket server for terminal streaming
 */
export function initWebSocketServer(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    // Only handle /ws/terminal path
    if (url.pathname !== '/ws/terminal') {
      socket.destroy();
      return;
    }

    // Parse query parameters
    const taskId = parseInt(url.searchParams.get('taskId') || '', 10);
    const token = url.searchParams.get('token');

    // Validate taskId
    if (isNaN(taskId) || taskId <= 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate if auth is configured
    const authConfig = getAuthConfig();
    if (authConfig) {
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      try {
        jwt.verify(token, authConfig.jwtSecret);
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // Upgrade connection
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Add client to task's client set
      if (!taskClients.has(taskId)) {
        taskClients.set(taskId, new Set());
      }
      taskClients.get(taskId)!.add(ws);

      console.log(`[WS] Client connected for task ${taskId}, total: ${taskClients.get(taskId)!.size}`);

      ws.on('close', () => {
        const clients = taskClients.get(taskId);
        if (clients) {
          clients.delete(ws);
          if (clients.size === 0) {
            taskClients.delete(taskId);
          }
        }
        console.log(`[WS] Client disconnected for task ${taskId}`);
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error for task ${taskId}:`, err.message);
      });

      // Handle incoming messages (for future resize support)
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'resize') {
            // Future: handle terminal resize
            console.log(`[WS] Resize request for task ${taskId}: ${msg.cols}x${msg.rows}`);
          }
        } catch {
          // Ignore invalid messages
        }
      });

      wss.emit('connection', ws, request, taskId);
    });
  });

  return wss;
}

/**
 * Broadcast terminal output to all clients for a task
 */
export function broadcastOutput(taskId: number, data: string): void {
  const clients = taskClients.get(taskId);
  if (!clients || clients.size === 0) return;

  const message: TerminalOutputMessage = { type: 'output', data };
  const json = JSON.stringify(message);

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

/**
 * Broadcast session ID to all clients for a task
 */
export function broadcastSession(taskId: number, sessionId: string): void {
  const clients = taskClients.get(taskId);
  if (!clients || clients.size === 0) return;

  const message: TerminalSessionMessage = { type: 'session', sessionId };
  const json = JSON.stringify(message);

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

/**
 * Broadcast task end to all clients for a task
 */
export function broadcastEnd(taskId: number, status: string, exitCode: number): void {
  const clients = taskClients.get(taskId);
  if (!clients || clients.size === 0) return;

  const message: TerminalEndMessage = { type: 'end', status, exitCode };
  const json = JSON.stringify(message);

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
      client.close();
    }
  });

  // Clean up after notifying all clients
  taskClients.delete(taskId);
}

/**
 * Broadcast error to all clients for a task
 */
export function broadcastError(taskId: number, errorMessage: string): void {
  const clients = taskClients.get(taskId);
  if (!clients || clients.size === 0) return;

  const message: TerminalErrorMessage = { type: 'error', message: errorMessage };
  const json = JSON.stringify(message);

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
      client.close();
    }
  });

  // Clean up after notifying all clients
  taskClients.delete(taskId);
}

/**
 * Get count of connected clients for a task
 */
export function getClientCount(taskId: number): number {
  return taskClients.get(taskId)?.size || 0;
}
