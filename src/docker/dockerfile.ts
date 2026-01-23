import fs from 'fs';
import path from 'path';

const TEMPLATE_PATH = path.join(__dirname, '../../draken.dockerfile.template');
const DOCKERFILE_NAME = 'Dockerfile.draken';

export function getDockerfilePath(projectPath: string): string {
  return path.join(projectPath, DOCKERFILE_NAME);
}

export function dockerfileExists(projectPath: string): boolean {
  return fs.existsSync(getDockerfilePath(projectPath));
}

export function generateDockerfile(projectPath: string): void {
  const templateContent = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const dockerfilePath = getDockerfilePath(projectPath);
  fs.writeFileSync(dockerfilePath, templateContent);
}

export function getDockerfileContent(projectPath: string): string | null {
  const dockerfilePath = getDockerfilePath(projectPath);
  if (fs.existsSync(dockerfilePath)) {
    return fs.readFileSync(dockerfilePath, 'utf-8');
  }
  return null;
}
