import { useState, useEffect } from 'react';
import {
  GitBranch,
  GitCommit,
  FileEdit,
  FilePlus,
  FileX,
  FileQuestion,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from 'lucide-react';
import { getGitStatus, getFileContent, getFileDiffContent } from '../api';
import { DiffViewer, FileContentViewer } from './DiffViewer';
import { Modal } from './Modal';
import type { GitStatus, GitFileChange } from '../types';

interface GitStatusPanelProps {
  projectId: number;
}

interface DiffContent {
  oldContent: string;
  newContent: string;
}

export function GitStatusPanel({ projectId }: GitStatusPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedFile, setSelectedFile] = useState<GitFileChange | null>(null);
  const [diffContent, setDiffContent] = useState<DiffContent | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const loadGitInfo = async () => {
    try {
      const statusData = await getGitStatus(projectId);
      setStatus(statusData);
    } catch (err) {
      console.error('Failed to load git info:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadGitInfo();
  }, [projectId]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadGitInfo();
  };

  const handleFileClick = async (change: GitFileChange) => {
    setSelectedFile(change);
    setDiffContent(null);
    setFileContent(null);
    setFileLoading(true);

    try {
      if (change.status === 'untracked') {
        // For untracked files, just get the content
        const response = await getFileContent(projectId, change.path);
        if (response.content) {
          setFileContent(response.content);
        } else if (response.isDirectory) {
          setFileContent('(Directory)');
        } else if (response.isBinary) {
          setFileContent('(Binary file)');
        } else if (response.tooLarge) {
          setFileContent(`(File too large: ${Math.round(response.size! / 1024)}KB)`);
        }
      } else {
        // For modified/staged files, get old and new content
        const content = await getFileDiffContent(projectId, change.path, change.staged);
        setDiffContent({
          oldContent: content.oldContent,
          newContent: content.newContent,
        });
      }
    } catch (err) {
      console.error('Failed to load file diff:', err);
      setFileContent('(Failed to load file)');
    } finally {
      setFileLoading(false);
    }
  };

  const closeFileModal = () => {
    setSelectedFile(null);
    setDiffContent(null);
    setFileContent(null);
  };

  if (loading) {
    return (
      <div className="card git-panel">
        <div className="git-panel-header">
          <h3><GitBranch size={18} /> Git Status</h3>
        </div>
        <div className="git-loading">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (!status?.isRepo) {
    return (
      <div className="card git-panel">
        <div className="git-panel-header">
          <h3><GitBranch size={18} /> Git Status</h3>
        </div>
        <p className="text-muted">Not a git repository</p>
      </div>
    );
  }

  const stagedChanges = status.changes.filter(c => c.staged);
  const unstagedChanges = status.changes.filter(c => !c.staged && c.status !== 'untracked');
  const untrackedFiles = status.changes.filter(c => c.status === 'untracked');

  return (
    <>
      <div className="card git-panel">
        <div className="git-panel-header">
          <h3><GitBranch size={18} /> Git Status</h3>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw size={16} className={refreshing ? 'spinning' : ''} />
          </button>
        </div>

        {/* Branch info */}
        <div className="git-branch-info">
          <span className="branch-name">
            <GitBranch size={14} />
            {status.branch}
          </span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="branch-sync">
              {status.ahead > 0 && (
                <span className="ahead" title={`${status.ahead} commit(s) ahead`}>
                  <ArrowUp size={12} /> {status.ahead}
                </span>
              )}
              {status.behind > 0 && (
                <span className="behind" title={`${status.behind} commit(s) behind`}>
                  <ArrowDown size={12} /> {status.behind}
                </span>
              )}
            </span>
          )}
        </div>

        {/* Changes summary */}
        {status.changes.length === 0 ? (
          <p className="git-clean">
            <GitCommit size={14} /> Working tree clean
          </p>
        ) : (
          <div className="git-changes-container">
            {stagedChanges.length > 0 && (
              <div className="git-change-group">
                <div className="git-change-group-header staged">
                  <FilePlus size={14} />
                  Staged Changes ({stagedChanges.length})
                </div>
                {stagedChanges.map((change) => (
                  <FileChangeItem
                    key={`staged-${change.path}`}
                    change={change}
                    onClick={() => handleFileClick(change)}
                  />
                ))}
              </div>
            )}

            {unstagedChanges.length > 0 && (
              <div className="git-change-group">
                <div className="git-change-group-header unstaged">
                  <FileEdit size={14} />
                  Modified ({unstagedChanges.length})
                </div>
                {unstagedChanges.map((change) => (
                  <FileChangeItem
                    key={`unstaged-${change.path}`}
                    change={change}
                    onClick={() => handleFileClick(change)}
                  />
                ))}
              </div>
            )}

            {untrackedFiles.length > 0 && (
              <div className="git-change-group">
                <div className="git-change-group-header untracked">
                  <FileQuestion size={14} />
                  Untracked ({untrackedFiles.length})
                </div>
                {untrackedFiles.map((change) => (
                  <FileChangeItem
                    key={`untracked-${change.path}`}
                    change={change}
                    onClick={() => handleFileClick(change)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* File diff/content modal */}
      <Modal
        isOpen={!!selectedFile}
        onClose={closeFileModal}
        large
        title={
          <span className="diff-modal-title">
            <FileIcon status={selectedFile?.status || 'modified'} />
            {selectedFile?.path}
            {selectedFile?.staged && <span className="diff-staged-badge">Staged</span>}
            {selectedFile?.status === 'untracked' && <span className="diff-new-badge">New file</span>}
          </span>
        }
        footer={
          <button className="btn btn-secondary" onClick={closeFileModal}>
            Close
          </button>
        }
      >
        {fileLoading ? (
          <div className="diff-loading">
            <span className="spinner" />
          </div>
        ) : selectedFile?.status === 'untracked' ? (
          fileContent ? (
            <FileContentViewer content={fileContent} />
          ) : (
            <div className="diff-viewer-empty">Cannot display file</div>
          )
        ) : diffContent ? (
          <DiffViewer
            oldValue={diffContent.oldContent}
            newValue={diffContent.newContent}
          />
        ) : (
          <div className="diff-viewer-empty">No changes to display</div>
        )}
      </Modal>
    </>
  );
}

function FileIcon({ status }: { status: GitFileChange['status'] }) {
  switch (status) {
    case 'modified': return <FileEdit size={16} className="status-modified" />;
    case 'added': return <FilePlus size={16} className="status-added" />;
    case 'deleted': return <FileX size={16} className="status-deleted" />;
    case 'untracked': return <FileQuestion size={16} className="status-untracked" />;
    default: return <FileEdit size={16} />;
  }
}

function FileChangeItem({ change, onClick }: { change: GitFileChange; onClick: () => void }) {
  return (
    <button className={`git-file-item ${change.status}`} onClick={onClick}>
      <FileIcon status={change.status} />
      <span className="file-path">{change.path}</span>
      <ChevronRight size={14} className="file-arrow" />
    </button>
  );
}
