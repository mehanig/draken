import { Clock, Play, Check, AlertCircle } from 'lucide-react';

interface StatusBadgeProps {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'ready';
}

const statusConfig = {
  pending: { icon: Clock, label: 'Pending' },
  running: { icon: Play, label: 'Running' },
  completed: { icon: Check, label: 'Completed' },
  failed: { icon: AlertCircle, label: 'Failed' },
  ready: { icon: Check, label: 'Ready' },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <span className={`status-badge ${status}`}>
      {status === 'running' ? (
        <span className="spinner spinner-sm" />
      ) : (
        <Icon size={12} />
      )}
      {config.label}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot ${status}`} />;
}
