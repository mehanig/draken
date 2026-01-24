import { useState, useEffect, useRef } from 'react';
import { Square, Send } from 'lucide-react';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { stopTask, createFollowupTask } from '../api';
import type { Task } from '../types';

interface TaskLogsModalProps {
  task: Task | null;
  onClose: () => void;
  onTaskUpdate: () => void;
}

export function TaskLogsModal({ task, onClose, onTaskUpdate }: TaskLogsModalProps) {
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState<Task['status']>('pending');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [followupText, setFollowupText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const logsRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!task) return;

    setLogs(task.logs || '');
    setStatus(task.status);
    setSessionId(task.session_id);
    setFollowupText('');

    // Connect to SSE for live logs
    const eventSource = new EventSource(`/api/tasks/${task.id}/logs`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'log') {
        setLogs((prev) => prev + data.data);
      } else if (data.type === 'session') {
        setSessionId(data.sessionId);
      } else if (data.type === 'end') {
        setStatus(data.status || 'completed');
        onTaskUpdate();
        eventSource.close();
      } else if (data.type === 'error') {
        setLogs((prev) => prev + `\nError: ${data.message}\n`);
        setStatus('failed');
        onTaskUpdate();
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [task?.id]);

  // Auto-scroll logs
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  const handleStop = async () => {
    if (!task) return;
    setStopping(true);
    try {
      await stopTask(task.id);
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
      // Update modal to show new task
      setLogs('');
      setStatus('running');
      setSessionId(newTask.session_id);

      // Close old event source and connect to new one
      eventSourceRef.current?.close();
      const eventSource = new EventSource(`/api/tasks/${newTask.id}/logs`);
      eventSourceRef.current = eventSource;

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLogs((prev) => prev + data.data);
        } else if (data.type === 'session') {
          setSessionId(data.sessionId);
        } else if (data.type === 'end') {
          setStatus(data.status || 'completed');
          onTaskUpdate();
          eventSource.close();
        } else if (data.type === 'error') {
          setLogs((prev) => prev + `\nError: ${data.message}\n`);
          setStatus('failed');
          onTaskUpdate();
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
      };
    } catch (err) {
      console.error('Failed to send followup:', err);
    } finally {
      setSending(false);
    }
  };

  const isRunning = status === 'running';
  const isCompleted = status === 'completed';
  const canFollowup = isCompleted && sessionId;

  return (
    <Modal
      isOpen={!!task}
      onClose={onClose}
      large
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
      <pre ref={logsRef} className="logs-content">
        {logs || 'Waiting for output...'}
      </pre>

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
