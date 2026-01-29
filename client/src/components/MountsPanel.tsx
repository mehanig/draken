import { useState, useEffect } from 'react';
import {
  FolderGit2,
  Plus,
  Trash2,
  Check,
  X,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import { getProjectMounts, addProjectMount, removeProjectMount, browsePath } from '../api';
import type { MountConfig, BrowseResponse } from '../types';

interface MountsPanelProps {
  projectId: number;
  dockerfileExists: boolean;
}

export function MountsPanel({ projectId, dockerfileExists }: MountsPanelProps) {
  const [mounts, setMounts] = useState<MountConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newAlias, setNewAlias] = useState('');
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseResponse | null>(null);

  const loadMounts = async () => {
    try {
      const data = await getProjectMounts(projectId);
      setMounts(data);
    } catch (err) {
      console.error('Failed to load mounts:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (dockerfileExists) {
      loadMounts();
    } else {
      setLoading(false);
    }
  }, [projectId, dockerfileExists]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadMounts();
  };

  const handleAddMount = async () => {
    if (!newPath.trim()) return;

    setAdding(true);
    try {
      const updated = await addProjectMount(projectId, newPath.trim(), newAlias.trim() || undefined);
      setMounts(updated);
      setNewPath('');
      setNewAlias('');
      setShowAddForm(false);
      setBrowsing(false);
      setBrowseData(null);
    } catch (err) {
      console.error('Failed to add mount:', err);
      alert(err instanceof Error ? err.message : 'Failed to add mount');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveMount = async (alias: string) => {
    if (!confirm(`Remove mount "${alias}"?`)) return;

    try {
      const updated = await removeProjectMount(projectId, alias);
      setMounts(updated);
    } catch (err) {
      console.error('Failed to remove mount:', err);
      alert(err instanceof Error ? err.message : 'Failed to remove mount');
    }
  };

  const handleBrowse = async (path?: string) => {
    try {
      const data = await browsePath(path);
      setBrowseData(data);
      setBrowsing(true);
    } catch (err) {
      console.error('Failed to browse:', err);
    }
  };

  const handleSelectPath = (path: string) => {
    setNewPath(path);
    setBrowsing(false);
    setBrowseData(null);
  };

  if (!dockerfileExists) {
    return null;
  }

  if (loading) {
    return (
      <div className="mounts-panel embedded">
        <div className="mounts-panel-header">
          <h4><FolderGit2 size={16} /> Mounts</h4>
        </div>
        <div className="mounts-loading">
          <span className="spinner spinner-sm" />
        </div>
      </div>
    );
  }

  return (
    <div className="mounts-panel embedded">
      <div className="mounts-panel-header">
        <h4><FolderGit2 size={16} /> Mounts</h4>
        <div className="mounts-actions">
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
          >
            <Plus size={14} /> Add Mount
          </button>
        </div>
      </div>

      {mounts.length === 0 && !showAddForm ? (
        <p className="text-muted">No mounts configured. Add directories to work with multiple repositories.</p>
      ) : (
        <div className="mounts-list">
          {mounts.map((mount) => (
            <div key={mount.alias} className="mount-item">
              <div className="mount-info">
                <span className="mount-alias">{mount.alias}</span>
                <span className="mount-path">{mount.path}</span>
              </div>
              <button
                className="btn btn-ghost btn-icon btn-sm mount-remove"
                onClick={() => handleRemoveMount(mount.alias)}
                title="Remove mount"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAddForm && (
        <div className="mount-add-form">
          <div className="mount-add-fields">
            <div className="mount-path-input">
              <input
                type="text"
                placeholder="Path to directory..."
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                disabled={adding}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => handleBrowse(newPath || undefined)}
                disabled={adding}
                title="Browse"
              >
                <FolderOpen size={14} />
              </button>
            </div>
            <input
              type="text"
              placeholder="Alias (optional)"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              disabled={adding}
              className="mount-alias-input"
            />
          </div>
          
          {browsing && browseData && (
            <div className="mount-browser">
              <div className="browser-current">
                <strong>Current:</strong> {browseData.currentPath}
              </div>
              {browseData.parentPath && (
                <button
                  className="browser-item browser-parent"
                  onClick={() => handleBrowse(browseData.parentPath!)}
                >
                  📁 ..
                </button>
              )}
              {browseData.entries.map((entry) => (
                <button
                  key={entry.path}
                  className="browser-item"
                  onClick={() => handleBrowse(entry.path)}
                  onDoubleClick={() => handleSelectPath(entry.path)}
                >
                  📁 {entry.name}
                </button>
              ))}
              <button
                className="btn btn-sm btn-primary browser-select"
                onClick={() => handleSelectPath(browseData.currentPath)}
              >
                Select "{browseData.currentPath}"
              </button>
            </div>
          )}

          <div className="mount-add-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleAddMount}
              disabled={adding || !newPath.trim()}
            >
              {adding ? <span className="spinner spinner-sm" /> : <Check size={14} />}
              Add
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowAddForm(false);
                setNewPath('');
                setNewAlias('');
                setBrowsing(false);
                setBrowseData(null);
              }}
              disabled={adding}
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      <p className="mounts-hint">
        Directories are mounted to <code>/workspace/[alias]</code> in the container.
      </p>
    </div>
  );
}
