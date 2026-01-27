import { useState, useEffect, useRef, useMemo } from 'react';
import { Square, Send } from 'lucide-react';
import { Modal } from './Modal';
import { StatusBadge } from './StatusBadge';
import { stopTask, createFollowupTask, getAuthToken } from '../api';
import type { Task } from '../types';
import AnsiToHtml from 'ansi-to-html';

// Build SSE URL with auth token (EventSource doesn't support headers)
function buildSSEUrl(taskId: number): string {
  const token = getAuthToken();
  const url = `/api/tasks/${taskId}/logs`;
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

interface TaskLogsModalProps {
  task: Task | null;
  onClose: () => void;
  onTaskUpdate: () => void;
}

// Create ANSI to HTML converter with terminal-like colors
const ansiConverter = new AnsiToHtml({
  fg: '#d4d4d4',
  bg: 'transparent',
  colors: {
    0: '#1e1e1e',   // black
    1: '#f44747',   // red
    2: '#6a9955',   // green
    3: '#dcdcaa',   // yellow
    4: '#569cd6',   // blue
    5: '#c586c0',   // magenta
    6: '#4ec9b0',   // cyan
    7: '#d4d4d4',   // white
    8: '#808080',   // bright black
    9: '#f44747',   // bright red
    10: '#6a9955',  // bright green
    11: '#dcdcaa',  // bright yellow
    12: '#569cd6',  // bright blue
    13: '#c586c0',  // bright magenta
    14: '#4ec9b0',  // bright cyan
    15: '#ffffff',  // bright white
  },
});

export function TaskLogsModal({ task, onClose, onTaskUpdate }: TaskLogsModalProps) {
  const [logs, setLogs] = useState('');
  const [status, setStatus] = useState<Task['status']>('pending');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [followupText, setFollowupText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Convert ANSI codes to HTML
  const logsHtml = useMemo(() => {
    if (!logs) return '';
    return ansiConverter.toHtml(logs);
  }, [logs]);

  useEffect(() => {
    if (!task) return;

    setLogs(task.logs || '');
    setStatus(task.status);
    setSessionId(task.session_id);
    setFollowupText('');

    // Connect to SSE for live logs (pass token via query param)
    const eventSource = new EventSource(buildSSEUrl(task.id));
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
      const eventSource = new EventSource(buildSSEUrl(newTask.id));
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
      <div 
        ref={logsRef} 
        className="logs-content logs-terminal"
        dangerouslySetInnerHTML={{ 
          __html: logsHtml || '<span class="logs-waiting">Waiting for output...</span>' 
        }}
      />

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
