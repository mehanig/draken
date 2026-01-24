import Docker from 'dockerode';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess, execSync } from 'child_process';
import { getDockerfilePath } from './dockerfile';

// Detect Docker socket path
function getDockerSocket(): string | undefined {
  // Check DOCKER_HOST environment variable first
  if (process.env.DOCKER_HOST) {
    return process.env.DOCKER_HOST.replace('unix://', '');
  }

  // Try common socket paths
  const socketPaths = [
    '/var/run/docker.sock',
    `${process.env.HOME}/.docker/desktop/docker.sock`,
    '/run/docker.sock',
  ];

  for (const socketPath of socketPaths) {
    if (fs.existsSync(socketPath)) {
      return socketPath;
    }
  }

  return undefined;
}

const socketPath = getDockerSocket();
const docker = socketPath ? new Docker({ socketPath }) : new Docker();
const IMAGE_PREFIX = 'draken-project-';

// Store active task processes for interactive input
const activeProcesses = new Map<number, ChildProcess>();

export interface ContainerLogEmitter extends EventEmitter {
  on(event: 'log', listener: (data: string) => void): this;
  on(event: 'end', listener: (exitCode: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'session', listener: (sessionId: string) => void): this;
}

export async function buildProjectImage(projectPath: string, projectId: number): Promise<string> {
  const imageName = `${IMAGE_PREFIX}${projectId}`;
  const dockerfilePath = getDockerfilePath(projectPath);
  const dockerfileName = path.basename(dockerfilePath);

  // Build the image using Docker CLI to avoid logging driver issues
  try {
    execSync(`docker build -t ${imageName} -f "${dockerfileName}" .`, {
      cwd: projectPath,
      stdio: 'pipe',
    });
  } catch (err) {
    const error = err as { stderr?: Buffer };
    const stderr = error.stderr?.toString() || 'Unknown build error';
    throw new Error(`Docker build failed: ${stderr}`);
  }

  return imageName;
}

export async function runTask(
  projectPath: string,
  projectId: number,
  prompt: string,
  taskId: number,
  resumeSessionId?: string  // Optional session ID to resume a conversation
): Promise<{ containerId: string; logEmitter: ContainerLogEmitter }> {
  const imageName = `${IMAGE_PREFIX}${projectId}`;

  // Check if image exists, build if not (using CLI to avoid logging driver issues)
  try {
    execSync(`docker image inspect ${imageName}`, { stdio: 'pipe' });
  } catch {
    await buildProjectImage(projectPath, projectId);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const logEmitter = new EventEmitter() as ContainerLogEmitter;

  // Create a persistent sessions directory for this project
  const sessionsDir = path.join(projectPath, '.draken-sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Build command args
  const dockerArgs = [
    'run',
    '--rm',
    '-v', `${projectPath}:/workspace`,
    '-v', `${sessionsDir}:/home/claude/.claude`,  // Persist Claude sessions
    '-e', `ANTHROPIC_API_KEY=${apiKey}`,
    '--log-driver', 'json-file',
    imageName,
    '-p', prompt,
    '--verbose',
    '--output-format', 'stream-json',
    '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
  ];

  // Add --resume if continuing a conversation
  if (resumeSessionId) {
    dockerArgs.push('--resume', resumeSessionId);
    console.log('[runTask] Resuming session:', resumeSessionId);
  }

  console.log('[runTask] Docker args:', dockerArgs.join(' '));

  const dockerProcess = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Store the process for later input
  activeProcesses.set(taskId, dockerProcess);

  // Generate a pseudo container ID from the process
  const containerId = `pid-${dockerProcess.pid}`;

  // Buffer for incomplete JSON lines
  let buffer = '';

  dockerProcess.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        // Debug: log all event types to understand the stream format
        console.log('[stream-json event]', event.type, event.session_id ? `session=${event.session_id}` : '');

        // Capture session_id from any event that has it
        if (event.session_id) {
          logEmitter.emit('session', event.session_id);
        }

        // Extract text content from stream-json events
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              logEmitter.emit('log', block.text);
            } else if (block.type === 'tool_use') {
              logEmitter.emit('log', `\n[Tool: ${block.name}]\n`);
            }
          }
        } else if (event.type === 'result') {
          // Final result
          if (event.result) {
            logEmitter.emit('log', `\n${event.result}\n`);
          }
        } else if (event.type === 'error') {
          logEmitter.emit('log', `\nError: ${event.error?.message || JSON.stringify(event)}\n`);
        }
      } catch {
        // Not JSON, emit as raw text
        logEmitter.emit('log', line + '\n');
      }
    }
  });

  dockerProcess.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    console.log('[stderr]', text);
    logEmitter.emit('log', text);
  });

  dockerProcess.on('close', (code: number | null) => {
    activeProcesses.delete(taskId);
    logEmitter.emit('end', code ?? 0);
  });

  dockerProcess.on('error', (err: Error) => {
    activeProcesses.delete(taskId);
    logEmitter.emit('error', err);
  });

  return { containerId, logEmitter };
}

export function sendInputToTask(taskId: number, input: string): boolean {
  const proc = activeProcesses.get(taskId);
  if (proc && proc.stdin && !proc.stdin.destroyed) {
    proc.stdin.write(input + '\n');
    return true;
  }
  return false;
}

export function isTaskRunning(taskId: number): boolean {
  return activeProcesses.has(taskId);
}

export async function stopContainer(containerId: string): Promise<void> {
  try {
    // Handle both process IDs (pid-XXX) and actual container IDs
    if (containerId.startsWith('pid-')) {
      const pid = parseInt(containerId.replace('pid-', ''), 10);
      process.kill(pid, 'SIGTERM');
    } else {
      const container = docker.getContainer(containerId);
      await container.stop({ t: 5 });
    }
  } catch (err: unknown) {
    const error = err as { statusCode?: number; code?: string };
    // Container/process might already be stopped or removed
    if (error.statusCode !== 404 && error.statusCode !== 304 && error.code !== 'ESRCH') {
      throw err;
    }
  }
}

export async function getContainerStatus(containerId: string): Promise<string> {
  try {
    if (containerId.startsWith('pid-')) {
      const pid = parseInt(containerId.replace('pid-', ''), 10);
      // Check if process is still running
      process.kill(pid, 0);
      return 'running';
    }
    const result = execSync(`docker inspect --format='{{.State.Status}}' ${containerId}`, { stdio: 'pipe' });
    return result.toString().trim();
  } catch {
    return 'removed';
  }
}

export async function imageExists(projectId: number): Promise<boolean> {
  const imageName = `${IMAGE_PREFIX}${projectId}`;
  try {
    execSync(`docker image inspect ${imageName}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
