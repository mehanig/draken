import { useState, useEffect, useMemo } from 'react';
import { Square, Send } from 'lucide-react';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { XTerminal } from './XTerminal';
import { stopTask, createFollowupTask, getAuthToken } from '../api';
import type { Task } from '../types';

interface TaskLogsModalProps {
  task: Task | null;
  sessionChain: Task[];
  onClose: () => void;
  onTaskUpdate: () => void;
}

/**
 * Build full terminal content from a session chain up to (and including) the target task.
 * Each task's logs are separated by a prompt header.
 */
function buildChainContent(chain: Task[], upToTaskId: number): string {
  let content = '';
  for (let i = 0; i < chain.length; i++) {
    const t = chain[i];
    if (i === 0) {
      // First task: show prompt header
      content += `\x1b[36m\x1b[1m━━━ Prompt ━━━\x1b[0m\r\n`;
      content += `\x1b[33m> ${t.prompt}\x1b[0m\r\n\r\n`;
    } else {
      // Follow-ups: separator + prompt
      content += '\r\n\x1b[36m\x1b[1m━━━ Follow-up ━━━\x1b[0m\r\n';
      content += `\x1b[33m> ${t.prompt}\x1b[0m\r\n\r\n`;
    }
    if (t.logs) {
      content += t.logs;
    }
    if (t.id === upToTaskId) break;
  }
  return content;
}

export function TaskLogsModal({ task, sessionChain, onClose, onTaskUpdate }: TaskLogsModalProps) {
  const [status, setStatus] = useState<Task['status']>('pending');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [followupText, setFollowupText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<number | null>(null);

  // Track if we should connect to live WebSocket
  const isLive = status === 'running' || status === 'pending';

  // Build initial terminal content from the full session chain
  const initialLogs = useMemo(() => {
    if (!task || !currentTaskId) return '';
    return buildChainContent(sessionChain, currentTaskId);
  }, [task?.id, currentTaskId, sessionChain]);

  useEffect(() => {
    if (!task) return;

    setStatus(task.status);
    setSessionId(task.session_id);
    setFollowupText('');
    setCurrentTaskId(task.id);
  }, [task?.id]);

  const handleStop = async () => {
    if (!currentTaskId) return;
    setStopping(true);
    try {
      await stopTask(currentTaskId);
    } catch (err) {
      console.error('Failed to stop task:', err);
    } finally {
      setStopping(false);
    }
  };

  const handleFollowup = async () => {
    if (!task || !followupText.trim()) return;

    setSending(true);
    try {
      const newTask = await createFollowupTask(task.id, followupText.trim());
      setFollowupText('');
      onTaskUpdate();

      // Add the new task to the chain so terminal content is rebuilt
      sessionChain.push(newTask);
      setCurrentTaskId(newTask.id);
      setStatus('running');
      setSessionId(newTask.session_id);
    } catch (err) {
      console.error('Failed to send followup:', err);
    } finally {
      setSending(false);
    }
  };

  const handleSessionId = (newSessionId: string) => {
    setSessionId(newSessionId);
  };

  const handleStatusChange = (newStatus: 'running' | 'completed' | 'failed') => {
    setStatus(newStatus);
    onTaskUpdate();
  };

  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const canFollowup = isCompleted && sessionId;

  return (
    <Modal
      isOpen={!!task}
      onClose={onClose}
      fullscreen
      title={
        <>
          Task Logs
          <StatusBadge status={status} />
        </>
      }
      footer={
        <>
          {isRunning && (
            <button
              className="btn btn-danger"
              onClick={handleStop}
              disabled={stopping}
            >
              <Square size={16} />
              {stopping ? 'Stopping...' : 'Stop Task'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="logs-content logs-terminal">
        {currentTaskId && (
          <XTerminal
            key={currentTaskId}
            taskId={currentTaskId}
            token={getAuthToken()}
            initialContent={initialLogs}
            isLive={isLive}
            onSessionId={handleSessionId}
            onStatusChange={handleStatusChange}
          />
        )}
      </div>

      {canFollowup && (
        <div className="followup-container">
          <input
            type="text"
            className="input"
            placeholder="Continue the conversation..."
            value={followupText}
            onChange={(e) => setFollowupText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleFollowup();
              }
            }}
            disabled={sending}
          />
          <button
            className="btn btn-primary"
            onClick={handleFollowup}
            disabled={!followupText.trim() || sending}
          >
            {sending ? (
              <span className="spinner spinner-sm" />
            ) : (
              <Send size={16} />
            )}
            Follow Up
          </button>
        </div>
      )}
    </Modal>
  );
}
