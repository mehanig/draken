import { useState, useEffect } from 'react';
import { Folder, ArrowUp } from 'lucide-react';
import { Modal } from './Modal';
import { browsePath, createProject } from '../api';
import type { BrowseResponse } from '../types';

interface DirectoryBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onProjectCreated: () => void;
}

export function DirectoryBrowser({ isOpen, onClose, onProjectCreated }: DirectoryBrowserProps) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadDirectory();
    }
  }, [isOpen]);

  const loadDirectory = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await browsePath(path);
      setData(result);
    } catch (err) {
      setError('Failed to browse directory');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = async () => {
    if (!data?.currentPath) return;

    setCreating(true);
    setError(null);
    try {
      await createProject(data.currentPath);
      onProjectCreated();
      onClose();
    } catch (err) {
      setError('Failed to add project');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Select Project Folder"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSelect}
            disabled={!data?.currentPath || creating}
          >
            {creating ? (
              <>
                <span className="spinner spinner-sm" /> Adding...
              </>
            ) : (
              'Select This Folder'
            )}
          </button>
        </>
      }
    >
      {error && (
        <div className="text-danger" style={{ marginBottom: '1rem' }}>
          {error}
        </div>
      )}

      <div className="current-path">
        {data?.currentPath || 'Loading...'}
      </div>

      <div className="directory-list">
        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <span className="spinner" />
          </div>
        ) : (
          <>
            {data?.parentPath && (
              <div
                className="directory-item parent"
                onClick={() => loadDirectory(data.parentPath!)}
              >
                <ArrowUp size={18} />
                <span>..</span>
              </div>
            )}
            {data?.entries.map((entry) => (
              <div
                key={entry.path}
                className="directory-item"
                onClick={() => loadDirectory(entry.path)}
              >
                <Folder size={18} />
                <span>{entry.name}</span>
              </div>
            ))}
            {data?.entries.length === 0 && !data.parentPath && (
              <div className="text-muted" style={{ padding: '1rem' }}>
                No subdirectories found
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
