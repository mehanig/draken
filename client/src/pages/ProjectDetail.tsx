import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  FolderOpen,
  FileCode,
  Send,
  Clock,
  Sparkles,
} from 'lucide-react';
import {
  fetchProjects,
  getDockerfileStatus,
  generateDockerfile,
  fetchTasks,
  createTask,
} from '../api';
import { StatusDot } from '../components/StatusBadge';
import { TaskLogsModal } from '../components/TaskLogsModal';
import { SessionThread, groupTasksBySession } from '../components/SessionThread';
import { GitStatusPanel } from '../components/GitStatusPanel';
import { MountsPanel } from '../components/MountsPanel';
import type { Project, Task, DockerfileStatus } from '../types';

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id!, 10);

  const [project, setProject] = useState<Project | null>(null);
  const [dockerfileStatus, setDockerfileStatus] = useState<DockerfileStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedSessionChain, setSelectedSessionChain] = useState<Task[]>([]);

  const loadProject = async () => {
    try {
      const projects = await fetchProjects();
      const found = projects.find((p) => p.id === projectId);
      setProject(found || null);
    } catch (err) {
      console.error('Failed to load project:', err);
    }
  };

  const loadDockerfileStatus = async () => {
    try {
      const status = await getDockerfileStatus(projectId);
      setDockerfileStatus(status);
    } catch (err) {
      console.error('Failed to load dockerfile status:', err);
    }
  };

  const loadTasks = async () => {
    try {
      const data = await fetchTasks(projectId);
      setTasks(data);
    } catch (err) {
      console.error('Failed to load tasks:', err);
    }
  };

  useEffect(() => {
    loadProject();
    loadDockerfileStatus();
    loadTasks();
  }, [projectId]);

  const handleGenerateDockerfile = async () => {
    setGenerating(true);
    try {
      const status = await generateDockerfile(projectId);
      setDockerfileStatus(status);
    } catch (err) {
      console.error('Failed to generate dockerfile:', err);
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmitTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setSubmitting(true);
    try {
      const task = await createTask(projectId, prompt.trim());
      setPrompt('');
      loadTasks();
      setSelectedTask(task);
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!project) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem' }}>
        <span className="spinner" />
      </div>
    );
  }

  return (
    <>
      <Link to="/" className="btn btn-secondary back-button">
        <ArrowLeft size={18} />
        Back to Projects
      </Link>

      <div className="page-header">
        <h2>{project.name}</h2>
      </div>

      {/* Project Info */}
      <div className="card project-info-card">
        <div className="project-info-row">
          <div className="project-path-display">
            <FolderOpen size={18} />
            <span>{project.path}</span>
          </div>

          <div className="dockerfile-status">
            <div className="dockerfile-status-text">
              <FileCode size={18} />
              {dockerfileStatus?.exists ? (
                <>
                  <StatusDot status="ready" />
                  <span className="text-success">Dockerfile ready</span>
                </>
              ) : (
                <>
                  <StatusDot status="pending" />
                  <span className="text-warning">Dockerfile not found</span>
                </>
              )}
            </div>
            {!dockerfileStatus?.exists && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleGenerateDockerfile}
                disabled={generating}
              >
                {generating ? (
                  <>
                    <span className="spinner spinner-sm" /> Generating...
                  </>
                ) : (
                  <>
                    <Sparkles size={14} /> Generate Dockerfile
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Embedded Mounts Panel */}
        <MountsPanel projectId={projectId} dockerfileExists={dockerfileStatus?.exists || false} />

        {/* Embedded Git Status */}
        <GitStatusPanel projectId={projectId} />
      </div>

      {/* Task Form */}
      <div className="card task-form-card">
        <h3>
          <Send size={18} style={{ marginRight: '0.5rem' }} />
          Submit Task
        </h3>
        <form onSubmit={handleSubmitTask}>
          <textarea
            className="textarea"
            placeholder="Enter your prompt for Claude Code..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
          />
          <div className="task-form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!prompt.trim() || submitting}
            >
              {submitting ? (
                <>
                  <span className="spinner spinner-sm" /> Submitting...
                </>
              ) : (
                <>
                  <Send size={16} /> Submit Task
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Sessions List */}
      <div className="tasks-section">
        <h3>
          <Clock size={18} style={{ marginRight: '0.5rem' }} />
          Sessions
        </h3>

        {tasks.length === 0 ? (
          <p className="text-muted">No sessions yet. Submit a prompt above to get started.</p>
        ) : (
          <div className="sessions-list">
            {groupTasksBySession(tasks).map((sessionTasks) => (
              <SessionThread
                key={sessionTasks[0].id}
                tasks={sessionTasks}
                onTaskClick={(task) => {
                  setSelectedTask(task);
                  setSelectedSessionChain(sessionTasks);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <TaskLogsModal
        task={selectedTask}
        sessionChain={selectedSessionChain}
        onClose={() => setSelectedTask(null)}
        onTaskUpdate={loadTasks}
      />
    </>
  );
}
