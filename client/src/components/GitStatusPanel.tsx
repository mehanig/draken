import { useState, useEffect } from 'react';
import {
  GitBranch,
  GitCommit,
  FileEdit,
  FilePlus,
  FileX,
  FileQuestion,
  ChevronRight,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  Plus,
  Check,
  X,
  Minus,
  FolderGit2,
} from 'lucide-react';
import {
  getGitStatus,
  getFileContent,
  getFileDiffContent,
  getBranches,
  createBranch,
  checkoutBranch,
  stageFiles,
  stageAll,
  unstageFiles,
  unstageAll,
  commitChanges,
  type GitBranch as GitBranchType,
} from '../api';
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

interface RepoStatusData {
  mount: string;
  path: string;
  status: GitStatus;
  branches: GitBranchType[];
}

export function GitStatusPanel({ projectId }: GitStatusPanelProps) {
  const [repos, setRepos] = useState<RepoStatusData[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  
  // File diff modal state
  const [selectedFile, setSelectedFile] = useState<{ change: GitFileChange; mount: string } | null>(null);
  const [diffContent, setDiffContent] = useState<DiffContent | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const loadGitInfo = async () => {
    try {
      const statusData = await getGitStatus(projectId);
      
      // Handle both single repo (GitStatus) and multi-repo (MultiRepoGitStatus[]) responses
      let repoStatuses: { mount: string; path: string; status: GitStatus }[];
      
      if (Array.isArray(statusData)) {
        repoStatuses = statusData;
      } else {
        // Single repo mode - wrap in array
        repoStatuses = [{ mount: 'main', path: '', status: statusData }];
      }
      
      // Load branches for each repo
      const reposWithBranches = await Promise.all(
        repoStatuses.map(async (repo) => {
          const branches = await getBranches(projectId, repo.mount !== 'main' ? repo.mount : undefined);
          return { ...repo, branches };
        })
      );
      
      setRepos(reposWithBranches);
      
      // Set active repo if not set
      if (!activeRepo && reposWithBranches.length > 0) {
        setActiveRepo(reposWithBranches[0].mount);
      }
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

  const handleFileClick = async (change: GitFileChange, mount: string) => {
    setSelectedFile({ change, mount });
    setDiffContent(null);
    setFileContent(null);
    setFileLoading(true);

    const mountParam = mount !== 'main' ? mount : undefined;

    try {
      if (change.status === 'untracked') {
        const response = await getFileContent(projectId, change.path, mountParam);
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
        const content = await getFileDiffContent(projectId, change.path, change.staged, mountParam);
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

  if (repos.length === 0 || repos.every(r => !r.status.isRepo)) {
    return (
      <div className="card git-panel">
        <div className="git-panel-header">
          <h3><GitBranch size={18} /> Git Status</h3>
        </div>
        <p className="text-muted">No git repositories found</p>
      </div>
    );
  }

  const isMultiRepo = repos.length > 1;

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

        {/* Repo tabs for multi-repo projects */}
        {isMultiRepo && (
          <div className="git-repo-tabs">
            {repos.filter(r => r.status.isRepo).map((repo) => (
              <button
                key={repo.mount}
                className={`repo-tab ${activeRepo === repo.mount ? 'active' : ''}`}
                onClick={() => setActiveRepo(repo.mount)}
              >
                <FolderGit2 size={14} />
                {repo.mount}
                {repo.status.changes.length > 0 && (
                  <span className="repo-badge">{repo.status.changes.length}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Active repo content */}
        {repos.filter(r => r.status.isRepo).map((repo) => (
          <div
            key={repo.mount}
            className={`git-repo-content ${activeRepo === repo.mount || !isMultiRepo ? 'active' : ''}`}
          >
            <RepoStatusContent
              projectId={projectId}
              repo={repo}
              isMultiRepo={isMultiRepo}
              onFileClick={(change) => handleFileClick(change, repo.mount)}
              onRefresh={loadGitInfo}
            />
          </div>
        ))}
      </div>

      {/* File diff/content modal */}
      <Modal
        isOpen={!!selectedFile}
        onClose={closeFileModal}
        fullscreen
        title={
          <span className="diff-modal-title">
            <FileIcon status={selectedFile?.change.status || 'modified'} />
            {selectedFile?.change.path}
            {selectedFile?.change.staged && <span className="diff-staged-badge">Staged</span>}
            {selectedFile?.change.status === 'untracked' && <span className="diff-new-badge">New file</span>}
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
        ) : selectedFile?.change.status === 'untracked' ? (
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

interface RepoStatusContentProps {
  projectId: number;
  repo: RepoStatusData;
  isMultiRepo: boolean;
  onFileClick: (change: GitFileChange) => void;
  onRefresh: () => void;
}

function RepoStatusContent({ projectId, repo, isMultiRepo, onFileClick, onRefresh }: RepoStatusContentProps) {
  const { status, branches, mount } = repo;
  const mountParam = isMultiRepo ? mount : undefined;
  
  // Branch UI state
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showNewBranchInput, setShowNewBranchInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [branchLoading, setBranchLoading] = useState(false);
  
  // Commit UI state
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [showCommitForm, setShowCommitForm] = useState(false);

  const handleBranchCheckout = async (branchName: string) => {
    setBranchLoading(true);
    try {
      await checkoutBranch(projectId, branchName, mountParam);
      onRefresh();
      setShowBranchDropdown(false);
    } catch (err) {
      console.error('Failed to checkout branch:', err);
      alert(err instanceof Error ? err.message : 'Failed to checkout branch');
    } finally {
      setBranchLoading(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    
    setBranchLoading(true);
    try {
      await createBranch(projectId, newBranchName.trim(), true, mountParam);
      onRefresh();
      setNewBranchName('');
      setShowNewBranchInput(false);
      setShowBranchDropdown(false);
    } catch (err) {
      console.error('Failed to create branch:', err);
      alert(err instanceof Error ? err.message : 'Failed to create branch');
    } finally {
      setBranchLoading(false);
    }
  };

  const handleStageFile = async (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    try {
      await stageFiles(projectId, [filePath], mountParam);
      onRefresh();
    } catch (err) {
      console.error('Failed to stage file:', err);
    }
  };

  const handleUnstageFile = async (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    try {
      await unstageFiles(projectId, [filePath], mountParam);
      onRefresh();
    } catch (err) {
      console.error('Failed to unstage file:', err);
    }
  };

  const handleStageAll = async () => {
    try {
      await stageAll(projectId, mountParam);
      onRefresh();
    } catch (err) {
      console.error('Failed to stage all:', err);
    }
  };

  const handleUnstageAll = async () => {
    try {
      await unstageAll(projectId, mountParam);
      onRefresh();
    } catch (err) {
      console.error('Failed to unstage all:', err);
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    
    setCommitting(true);
    try {
      await commitChanges(projectId, commitMessage.trim(), mountParam);
      setCommitMessage('');
      setShowCommitForm(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to commit:', err);
      alert(err instanceof Error ? err.message : 'Failed to commit');
    } finally {
      setCommitting(false);
    }
  };

  const stagedChanges = status.changes.filter(c => c.staged);
  const unstagedChanges = status.changes.filter(c => !c.staged && c.status !== 'untracked');
  const untrackedFiles = status.changes.filter(c => c.status === 'untracked');

  return (
    <>
      {/* Branch selector */}
      <div className="git-branch-selector">
        <div className="branch-current" onClick={() => setShowBranchDropdown(!showBranchDropdown)}>
          <GitBranch size={14} />
          <span className="branch-name">{status.branch}</span>
          <ChevronDown size={14} className={showBranchDropdown ? 'rotated' : ''} />
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
        
        {showBranchDropdown && (
          <div className="branch-dropdown">
            {showNewBranchInput ? (
              <div className="branch-new-input">
                <input
                  type="text"
                  placeholder="New branch name..."
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateBranch();
                    if (e.key === 'Escape') setShowNewBranchInput(false);
                  }}
                  autoFocus
                  disabled={branchLoading}
                />
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleCreateBranch}
                  disabled={branchLoading || !newBranchName.trim()}
                >
                  <Check size={14} />
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setShowNewBranchInput(false)}
                  disabled={branchLoading}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                className="branch-item branch-new"
                onClick={() => setShowNewBranchInput(true)}
              >
                <Plus size={14} /> Create new branch
              </button>
            )}
            
            <div className="branch-list">
              {branches.map((branch) => (
                <button
                  key={branch.name}
                  className={`branch-item ${branch.current ? 'current' : ''}`}
                  onClick={() => !branch.current && handleBranchCheckout(branch.name)}
                  disabled={branch.current || branchLoading}
                >
                  {branch.current && <Check size={14} />}
                  {branch.name}
                </button>
              ))}
            </div>
          </div>
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
                <div className="header-left">
                  <FilePlus size={14} />
                  Staged Changes ({stagedChanges.length})
                </div>
                <button
                  className="btn btn-xs btn-ghost"
                  onClick={handleUnstageAll}
                  title="Unstage all"
                >
                  <Minus size={12} /> All
                </button>
              </div>
              {stagedChanges.map((change) => (
                <FileChangeItem
                  key={`staged-${change.path}`}
                  change={change}
                  onClick={() => onFileClick(change)}
                  onAction={(e) => handleUnstageFile(e, change.path)}
                  actionIcon={<Minus size={14} />}
                  actionTitle="Unstage"
                />
              ))}
            </div>
          )}

          {unstagedChanges.length > 0 && (
            <div className="git-change-group">
              <div className="git-change-group-header unstaged">
                <div className="header-left">
                  <FileEdit size={14} />
                  Modified ({unstagedChanges.length})
                </div>
                <button
                  className="btn btn-xs btn-ghost"
                  onClick={handleStageAll}
                  title="Stage all"
                >
                  <Plus size={12} /> All
                </button>
              </div>
              {unstagedChanges.map((change) => (
                <FileChangeItem
                  key={`unstaged-${change.path}`}
                  change={change}
                  onClick={() => onFileClick(change)}
                  onAction={(e) => handleStageFile(e, change.path)}
                  actionIcon={<Plus size={14} />}
                  actionTitle="Stage"
                />
              ))}
            </div>
          )}

          {untrackedFiles.length > 0 && (
            <div className="git-change-group">
              <div className="git-change-group-header untracked">
                <div className="header-left">
                  <FileQuestion size={14} />
                  Untracked ({untrackedFiles.length})
                </div>
                <button
                  className="btn btn-xs btn-ghost"
                  onClick={handleStageAll}
                  title="Stage all"
                >
                  <Plus size={12} /> All
                </button>
              </div>
              {untrackedFiles.map((change) => (
                <FileChangeItem
                  key={`untracked-${change.path}`}
                  change={change}
                  onClick={() => onFileClick(change)}
                  onAction={(e) => handleStageFile(e, change.path)}
                  actionIcon={<Plus size={14} />}
                  actionTitle="Stage"
                />
              ))}
            </div>
          )}

          {/* Commit section */}
          {stagedChanges.length > 0 && (
            <div className="git-commit-section">
              {showCommitForm ? (
                <div className="commit-form">
                  <textarea
                    placeholder="Commit message..."
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    rows={3}
                    autoFocus
                    disabled={committing}
                  />
                  <div className="commit-actions">
                    <button
                      className="btn btn-primary"
                      onClick={handleCommit}
                      disabled={committing || !commitMessage.trim()}
                    >
                      {committing ? <span className="spinner" /> : <GitCommit size={14} />}
                      Commit
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setShowCommitForm(false);
                        setCommitMessage('');
                      }}
                      disabled={committing}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-primary commit-btn"
                  onClick={() => setShowCommitForm(true)}
                >
                  <GitCommit size={14} /> Commit {stagedChanges.length} file{stagedChanges.length !== 1 ? 's' : ''}
                </button>
              )}
            </div>
          )}
        </div>
      )}
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

interface FileChangeItemProps {
  change: GitFileChange;
  onClick: () => void;
  onAction: (e: React.MouseEvent) => void;
  actionIcon: React.ReactNode;
  actionTitle: string;
}

function FileChangeItem({ change, onClick, onAction, actionIcon, actionTitle }: FileChangeItemProps) {
  return (
    <div className={`git-file-item ${change.status}`}>
      <button className="file-content" onClick={onClick}>
        <FileIcon status={change.status} />
        <span className="file-path">{change.path}</span>
        <ChevronRight size={14} className="file-arrow" />
      </button>
      <button
        className="btn btn-xs btn-ghost file-action"
        onClick={onAction}
        title={actionTitle}
      >
        {actionIcon}
      </button>
    </div>
  );
}
