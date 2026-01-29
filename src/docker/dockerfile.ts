import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.join(__dirname, '../../draken.dockerfile.template');
const DOCKERFILE_NAME = 'Dockerfile.draken';

export interface MountConfig {
  alias: string;
  path: string;
}

export function getDockerfilePath(projectPath: string): string {
  return path.join(projectPath, DOCKERFILE_NAME);
}

export function dockerfileExists(projectPath: string): boolean {
  return fs.existsSync(getDockerfilePath(projectPath));
}

/**
 * Parse DRAKEN_MOUNT comments from dockerfile content
 * Format: # DRAKEN_MOUNT alias=/path/to/directory
 */
export function parseMountsFromDockerfile(content: string): MountConfig[] {
  const mounts: MountConfig[] = [];
  const mountRegex = /^#\s*DRAKEN_MOUNT\s+([\w-]+)=(.+)$/gm;
  
  let match;
  while ((match = mountRegex.exec(content)) !== null) {
    const alias = match[1].trim();
    const mountPath = match[2].trim();
    if (alias && mountPath) {
      mounts.push({ alias, path: mountPath });
    }
  }
  
  return mounts;
}

/**
 * Generate mount comments for dockerfile
 */
export function generateMountComments(mounts: MountConfig[]): string {
  if (mounts.length === 0) return '';
  
  const lines = mounts.map(m => `# DRAKEN_MOUNT ${m.alias}=${m.path}`);
  return lines.join('\n') + '\n\n';
}

/**
 * Update mounts in dockerfile content
 * Replaces existing DRAKEN_MOUNT comments with new ones
 */
export function updateMountsInDockerfile(content: string, mounts: MountConfig[]): string {
  // Remove existing mount comments
  const withoutMounts = content.replace(/^#\s*DRAKEN_MOUNT\s+[\w-]+=.+\n?/gm, '');
  
  // Add new mount comments at the top
  const mountComments = generateMountComments(mounts);
  
  // Clean up any leading whitespace from removal
  const cleaned = withoutMounts.replace(/^\n+/, '');
  
  return mountComments + cleaned;
}

/**
 * Generate a new dockerfile with mount configuration
 */
export function generateDockerfile(projectPath: string, mounts?: MountConfig[]): void {
  const templateContent = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const dockerfilePath = getDockerfilePath(projectPath);
  
  let content = templateContent;
  if (mounts && mounts.length > 0) {
    content = generateMountComments(mounts) + templateContent;
  }
  
  fs.writeFileSync(dockerfilePath, content);
}

/**
 * Generate dockerfile with a single mount (backward compatible)
 */
export function generateDockerfileWithMount(projectPath: string, alias: string, mountPath: string): void {
  generateDockerfile(projectPath, [{ alias, path: mountPath }]);
}

export function getDockerfileContent(projectPath: string): string | null {
  const dockerfilePath = getDockerfilePath(projectPath);
  if (fs.existsSync(dockerfilePath)) {
    return fs.readFileSync(dockerfilePath, 'utf-8');
  }
  return null;
}

/**
 * Get mounts configured in a project's dockerfile
 */
export function getProjectMounts(projectPath: string): MountConfig[] {
  const content = getDockerfileContent(projectPath);
  if (!content) return [];
  return parseMountsFromDockerfile(content);
}

/**
 * Add a mount to an existing dockerfile
 */
export function addMountToDockerfile(projectPath: string, alias: string, mountPath: string): void {
  const content = getDockerfileContent(projectPath);
  if (!content) {
    throw new Error('Dockerfile does not exist');
  }
  
  const existingMounts = parseMountsFromDockerfile(content);
  
  // Check for duplicate alias
  if (existingMounts.some(m => m.alias === alias)) {
    throw new Error(`Mount with alias "${alias}" already exists`);
  }
  
  existingMounts.push({ alias, path: mountPath });
  const updatedContent = updateMountsInDockerfile(content, existingMounts);
  
  fs.writeFileSync(getDockerfilePath(projectPath), updatedContent);
}

/**
 * Remove a mount from dockerfile
 */
export function removeMountFromDockerfile(projectPath: string, alias: string): void {
  const content = getDockerfileContent(projectPath);
  if (!content) {
    throw new Error('Dockerfile does not exist');
  }
  
  const existingMounts = parseMountsFromDockerfile(content);
  const filteredMounts = existingMounts.filter(m => m.alias !== alias);
  
  if (filteredMounts.length === existingMounts.length) {
    throw new Error(`Mount with alias "${alias}" not found`);
  }
  
  const updatedContent = updateMountsInDockerfile(content, filteredMounts);
  fs.writeFileSync(getDockerfilePath(projectPath), updatedContent);
}

/**
 * Update a mount path in dockerfile
 */
export function updateMountInDockerfile(projectPath: string, alias: string, newPath: string): void {
  const content = getDockerfileContent(projectPath);
  if (!content) {
    throw new Error('Dockerfile does not exist');
  }
  
  const existingMounts = parseMountsFromDockerfile(content);
  const mount = existingMounts.find(m => m.alias === alias);
  
  if (!mount) {
    throw new Error(`Mount with alias "${alias}" not found`);
  }
  
  mount.path = newPath;
  const updatedContent = updateMountsInDockerfile(content, existingMounts);
  fs.writeFileSync(getDockerfilePath(projectPath), updatedContent);
}

/**
 * Derive alias from path (last directory name)
 */
export function deriveAliasFromPath(mountPath: string): string {
  const basename = path.basename(mountPath);
  // Sanitize: only allow alphanumeric, dash, underscore
  return basename.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}
