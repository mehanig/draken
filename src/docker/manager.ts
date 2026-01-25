import Docker from 'dockerode';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
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

/**
 * Get the Claude config directory path
 * Uses CLAUDE_CONFIG_DIR if set, otherwise defaults to ~/.claude
 */
export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Check if OAuth credentials exist in the Claude config directory
 */
export function hasOAuthCredentials(): boolean {
  const configDir = getClaudeConfigDir();
  const credentialsPath = path.join(configDir, '.credentials.json');
  return fs.existsSync(credentialsPath);
}

/**
 * Get authentication configuration for Claude
 * Returns either OAuth config (config dir to mount) or API key
 */
export interface ClaudeAuthConfig {
  type: 'oauth' | 'api_key';
  configDir?: string;  // For OAuth - directory to mount
  apiKey?: string;     // For API key auth
}

export function getClaudeAuthConfig(): ClaudeAuthConfig | null {
  // First, check for OAuth credentials (preferred)
  if (hasOAuthCredentials()) {
    return {
      type: 'oauth',
      configDir: getClaudeConfigDir(),
    };
  }

  // Second, check for API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return {
      type: 'api_key',
      apiKey,
    };
  }

  // No authentication available
  return null;
}

/**
 * Validate Claude authentication on startup
 * Throws if no auth method is available
 */
export function validateClaudeAuth(): void {
  const auth = getClaudeAuthConfig();

  if (!auth) {
    const configDir = getClaudeConfigDir();
    throw new Error(
      `Claude authentication not configured.\n\n` +
      `Option 1 (Recommended): Log in with your Anthropic account\n` +
      `  Run: claude login\n` +
      `  This creates OAuth credentials in ${configDir}\n\n` +
      `Option 2: Use an API key\n` +
      `  Set: ANTHROPIC_API_KEY=your-api-key\n`
    );
  }

  if (auth.type === 'oauth') {
    console.log(`Claude auth: OAuth credentials found in ${auth.configDir}`);
  } else {
    console.log('Claude auth: Using ANTHROPIC_API_KEY');
  }
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

  const auth = getClaudeAuthConfig();
  if (!auth) {
    throw new Error('Claude authentication not configured. Run "claude login" or set ANTHROPIC_API_KEY.');
  }

  const logEmitter = new EventEmitter() as ContainerLogEmitter;

  // Create a persistent sessions directory for this project
  const sessionsDir = path.join(projectPath, '.draken-sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  // Build docker run arguments
  const dockerArgs = [
    'run',
    '--rm',
    '-v', `${projectPath}:/workspace`,
    '--log-driver', 'json-file',
  ];

  // Add authentication based on type
  if (auth.type === 'oauth') {
    // Mount the Claude config directory for OAuth
    // Note: Cannot be read-only - Claude needs to write session data, refresh tokens, etc.
    dockerArgs.push('-v', `${auth.configDir}:/home/claude/.claude-config`);
    dockerArgs.push('-e', 'CLAUDE_CONFIG_DIR=/home/claude/.claude-config');

    // Also mount sessions dir for project-specific session persistence
    dockerArgs.push('-v', `${sessionsDir}:/home/claude/.claude-sessions`);
  } else {
    // API key auth
    dockerArgs.push('-e', `ANTHROPIC_API_KEY=${auth.apiKey}`);
    dockerArgs.push('-v', `${sessionsDir}:/home/claude/.claude`);
  }

  // Add the image and Claude CLI arguments
  dockerArgs.push(imageName);
  dockerArgs.push('-p', prompt);
  dockerArgs.push('--dangerously-skip-permissions');  // Skip permission prompts for non-interactive container
  dockerArgs.push('--verbose');
  dockerArgs.push('--output-format', 'stream-json');
  dockerArgs.push('--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep');

  // Add --resume if continuing a conversation
  if (resumeSessionId) {
    dockerArgs.push('--resume', resumeSessionId);
    console.log('[runTask] Resuming session:', resumeSessionId);
  }

  console.log('[runTask] Docker args:', dockerArgs.join(' '));

  const dockerProcess = spawn('docker', dockerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  console.log('[runTask] Docker process spawned, pid:', dockerProcess.pid);

  // Close stdin immediately for print mode - we don't need input
  // This signals to the container that there's no more input coming
  dockerProcess.stdin.end();

  // Store the process for later input
  activeProcesses.set(taskId, dockerProcess);

  // Generate a pseudo container ID from the process
  const containerId = `pid-${dockerProcess.pid}`;

  // Buffer for incomplete JSON lines
  let buffer = '';

  dockerProcess.stdout.on('data', (chunk: Buffer) => {
    const chunkStr = chunk.toString('utf-8');
    console.log('[stdout chunk]', chunkStr.substring(0, 200)); // Debug: show first 200 chars
    buffer += chunkStr;
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
              console.log('[emit log] text:', block.text.substring(0, 100));
              logEmitter.emit('log', block.text);
            } else if (block.type === 'tool_use') {
              console.log('[emit log] tool_use:', block.name);
              logEmitter.emit('log', `\n[Tool: ${block.name}]\n`);
            }
          }
        } else if (event.type === 'result') {
          // Final result
          if (event.result) {
            console.log('[emit log] result:', event.result.substring(0, 100));
            logEmitter.emit('log', `\n${event.result}\n`);
          }
        } else if (event.type === 'error') {
          console.log('[emit log] error:', event.error?.message);
          logEmitter.emit('log', `\nError: ${event.error?.message || JSON.stringify(event)}\n`);
        }
      } catch {
        // Not JSON, emit as raw text
        logEmitter.emit('log', line + '\n');
      }
    }
  });

  dockerProcess.stdout.on('end', () => {
    console.log('[stdout] stream ended');
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
