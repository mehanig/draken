import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import {
  getAllProjects,
  getProjectById,
  createProject,
  deleteProject,
  updateProjectDockerfileStatus,
} from '../db/queries';
import { dockerfileExists, generateDockerfile, getDockerfileContent } from '../docker/dockerfile';
import { buildProjectImage } from '../docker/manager';
import { CreateProjectRequest } from '../types';

const router = Router();

// Get all projects
router.get('/', (_req: Request, res: Response) => {
  try {
    const projects = getAllProjects();

    // Update dockerfile status for each project
    projects.forEach(project => {
      const exists = dockerfileExists(project.path);
      if (exists !== !!project.dockerfile_exists) {
        updateProjectDockerfileStatus(project.id, exists);
        project.dockerfile_exists = exists ? 1 : 0;
      }
    });

    res.json(projects);
  } catch (err) {
    console.error('Error fetching projects:', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

// Get single project
router.get('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const project = getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update dockerfile status
    const exists = dockerfileExists(project.path);
    if (exists !== !!project.dockerfile_exists) {
      updateProjectDockerfileStatus(project.id, exists);
      project.dockerfile_exists = exists ? 1 : 0;
    }

    res.json(project);
  } catch (err) {
    console.error('Error fetching project:', err);
    res.status(500).json({ error: 'Failed to fetch project' });
  }
});

// Create new project
router.post('/', (req: Request, res: Response) => {
  try {
    const { path: projectPath, name } = req.body as CreateProjectRequest;

    if (!projectPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    // Validate path exists
    if (!fs.existsSync(projectPath)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    // Use folder name as project name if not provided
    const projectName = name || path.basename(projectPath);

    const project = createProject(projectName, projectPath);

    // Check if dockerfile exists
    const exists = dockerfileExists(projectPath);
    if (exists) {
      updateProjectDockerfileStatus(project.id, true);
      project.dockerfile_exists = 1;
    }

    res.status(201).json(project);
  } catch (err: unknown) {
    const error = err as { code?: string };
    console.error('Error creating project:', err);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Project with this path already exists' });
    }
    res.status(500).json({ error: 'Failed to create project' });
  }
});

// Delete project
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const deleted = deleteProject(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// Get dockerfile status
router.get('/:id/dockerfile', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const project = getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const exists = dockerfileExists(project.path);
    const content = exists ? getDockerfileContent(project.path) : null;

    // Update status in DB if changed
    if (exists !== !!project.dockerfile_exists) {
      updateProjectDockerfileStatus(project.id, exists);
    }

    res.json({ exists, content });
  } catch (err) {
    console.error('Error checking dockerfile:', err);
    res.status(500).json({ error: 'Failed to check dockerfile' });
  }
});

// Generate dockerfile
router.post('/:id/generate-dockerfile', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const project = getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Generate dockerfile from template
    generateDockerfile(project.path);
    updateProjectDockerfileStatus(project.id, true);

    // Build the Docker image
    try {
      await buildProjectImage(project.path, project.id);
    } catch (buildErr) {
      console.error('Error building Docker image:', buildErr);
      // Dockerfile was created, but image build failed - still return success
      // The image will be built on first task run
    }

    const content = getDockerfileContent(project.path);
    res.json({ exists: true, content });
  } catch (err) {
    console.error('Error generating dockerfile:', err);
    res.status(500).json({ error: 'Failed to generate dockerfile' });
  }
});

export default router;
