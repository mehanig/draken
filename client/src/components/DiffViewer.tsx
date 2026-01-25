import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

interface DiffViewerProps {
  oldValue: string;
  newValue: string;
  splitView?: boolean;
  showDiffOnly?: boolean;
}

const darkTheme = {
  variables: {
    dark: {
      diffViewerBackground: '#0d1117',
      diffViewerColor: '#c9d1d9',
      addedBackground: 'rgba(46, 160, 67, 0.15)',
      addedColor: '#3fb950',
      removedBackground: 'rgba(248, 81, 73, 0.15)',
      removedColor: '#f85149',
      wordAddedBackground: 'rgba(46, 160, 67, 0.4)',
      wordRemovedBackground: 'rgba(248, 81, 73, 0.4)',
      addedGutterBackground: 'rgba(46, 160, 67, 0.2)',
      removedGutterBackground: 'rgba(248, 81, 73, 0.2)',
      gutterBackground: '#161b22',
      gutterBackgroundDark: '#0d1117',
      highlightBackground: 'rgba(56, 139, 253, 0.15)',
      highlightGutterBackground: 'rgba(56, 139, 253, 0.2)',
      codeFoldGutterBackground: '#161b22',
      codeFoldBackground: '#161b22',
      emptyLineBackground: '#0d1117',
      gutterColor: '#8b949e',
      addedGutterColor: '#3fb950',
      removedGutterColor: '#f85149',
      codeFoldContentColor: '#8b949e',
      diffViewerTitleBackground: '#161b22',
      diffViewerTitleColor: '#8b949e',
      diffViewerTitleBorderColor: '#30363d',
    },
  },
  line: {
    padding: '2px 10px',
  },
  contentText: {
    fontFamily: "'SF Mono', Monaco, Consolas, 'Liberation Mono', monospace",
    fontSize: '13px',
  },
  gutter: {
    minWidth: '40px',
    padding: '0 10px',
  },
};

export function DiffViewer({
  oldValue,
  newValue,
  splitView = false,
  showDiffOnly = true
}: DiffViewerProps) {
  if (!oldValue && !newValue) {
    return (
      <div className="diff-viewer-empty">
        No changes to display
      </div>
    );
  }

  return (
    <div className="diff-viewer-container">
      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={splitView}
        useDarkTheme={true}
        styles={darkTheme}
        showDiffOnly={showDiffOnly}
        extraLinesSurroundingDiff={3}
        compareMethod={DiffMethod.LINES}
        hideLineNumbers={false}
      />
    </div>
  );
}

// Simple wrapper for showing new file content (all additions)
interface FileContentViewerProps {
  content: string;
}

export function FileContentViewer({ content }: FileContentViewerProps) {
  if (!content) {
    return (
      <div className="diff-viewer-empty">
        Cannot display file
      </div>
    );
  }

  return (
    <div className="diff-viewer-container new-file">
      <ReactDiffViewer
        oldValue=""
        newValue={content}
        splitView={false}
        useDarkTheme={true}
        styles={darkTheme}
        showDiffOnly={false}
        compareMethod={DiffMethod.LINES}
        hideLineNumbers={false}
      />
    </div>
  );
}
