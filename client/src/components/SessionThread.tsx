import { MessageSquare, ChevronRight } from 'lucide-react';
import { StatusBadge } from './StatusBadge';
import type { Task } from '../types';

interface SessionThreadProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

export function SessionThread({ tasks, onTaskClick }: SessionThreadProps) {
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString();
  };

  const rootTask = tasks[0];
  const followups = tasks.slice(1);
  const latestTask = tasks[tasks.length - 1];

  return (
    <div className="session-thread">
      {/* Root task (original prompt) */}
      <div
        className="session-root card card-interactive"
        onClick={() => onTaskClick(latestTask)}
      >
        <div className="session-header">
          <div className="session-icon">
            <MessageSquare size={18} />
          </div>
          <div className="session-info">
            <p className="session-prompt">{rootTask.prompt}</p>
            <div className="session-meta">
              <span>{formatDate(rootTask.created_at)}</span>
              {followups.length > 0 && (
                <span className="session-count">
                  {followups.length} follow-up{followups.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
          <div className="session-status">
            <StatusBadge status={latestTask.status} />
          </div>
        </div>

        {/* Follow-up messages preview */}
        {followups.length > 0 && (
          <div className="session-followups">
            {followups.map((task) => (
              <div
                key={task.id}
                className="followup-item"
                onClick={(e) => {
                  e.stopPropagation();
                  onTaskClick(task);
                }}
              >
                <ChevronRight size={14} className="followup-arrow" />
                <span className="followup-prompt">{task.prompt}</span>
                <StatusBadge status={task.status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Helper function to group tasks by session
export function groupTasksBySession(tasks: Task[]): Task[][] {
  const rootTasks: Map<number, Task[]> = new Map();

  // First pass: identify root tasks and build parent-child relationships
  for (const task of tasks) {
    if (!task.parent_task_id) {
      // This is a root task
      rootTasks.set(task.id, [task]);
    }
  }

  // Second pass: attach follow-ups to their root tasks
  for (const task of tasks) {
    if (task.parent_task_id) {
      // Find the root task by traversing up the chain
      let rootId = task.parent_task_id;
      let parent = tasks.find((t) => t.id === rootId);

      while (parent && parent.parent_task_id) {
        rootId = parent.parent_task_id;
        parent = tasks.find((t) => t.id === rootId);
      }

      const chain = rootTasks.get(rootId);
      if (chain) {
        chain.push(task);
      } else {
        // Orphan followup - create its own group
        rootTasks.set(task.id, [task]);
      }
    }
  }

  // Sort each chain by created_at and convert to array
  const result: Task[][] = [];
  for (const [_, chain] of rootTasks) {
    chain.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    result.push(chain);
  }

  // Sort sessions by the most recent task's created_at (newest first)
  result.sort((a, b) => {
    const aLatest = new Date(a[a.length - 1].created_at).getTime();
    const bLatest = new Date(b[b.length - 1].created_at).getTime();
    return bLatest - aLatest;
  });

  return result;
}
