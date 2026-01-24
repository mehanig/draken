import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Folder, Trash2, FolderOpen } from 'lucide-react';
import { fetchProjects, deleteProject } from '../api';
import { DirectoryBrowser } from '../components/DirectoryBrowser';
import { StatusDot } from '../components/StatusBadge';
import type { Project } from '../types';

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(false);

  const loadProjects = async () => {
    try {
      const data = await fetchProjects();
      setProjects(data);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleDelete = async (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();

    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      await deleteProject(id);
      loadProjects();
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem' }}>
        <span className="spinner" />
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h2>Projects</h2>
        <button className="btn btn-primary" onClick={() => setBrowserOpen(true)}>
          <Plus size={18} />
          Add Project
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <FolderOpen size={64} className="empty-state-icon" />
          <h3>No projects yet</h3>
          <p className="text-muted">Add a project folder to get started with Claude Code</p>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => setBrowserOpen(true)}
            style={{ marginTop: '1rem' }}
          >
            <Plus size={18} />
            Add Your First Project
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/project/${project.id}`}
              className="card card-interactive project-card"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div className="project-card-header">
                <h3>{project.name}</h3>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={(e) => handleDelete(e, project.id)}
                  title="Delete project"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <p className="project-card-path">{project.path}</p>
              <div className="project-card-footer">
                <div className="project-status">
                  <StatusDot status={project.dockerfile_exists ? 'ready' : 'pending'} />
                  <span>
                    {project.dockerfile_exists ? 'Ready' : 'Dockerfile needed'}
                  </span>
                </div>
                <Folder size={20} className="text-muted" />
              </div>
            </Link>
          ))}
        </div>
      )}

      <DirectoryBrowser
        isOpen={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onProjectCreated={loadProjects}
      />
    </>
  );
}
