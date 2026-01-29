import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface XTerminalProps {
  taskId: number;
  token: string | null;
  initialContent?: string;
  isLive: boolean;
  onSessionId?: (sessionId: string) => void;
  onStatusChange?: (status: 'running' | 'completed' | 'failed') => void;
}

// Terminal theme matching the app's dark theme
const TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
};

export function XTerminal({
  taskId,
  token,
  initialContent,
  isLive,
  onSessionId,
  onStatusChange,
}: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Use refs for callbacks to avoid WebSocket reconnects on re-render
  const onSessionIdRef = useRef(onSessionId);
  const onStatusChangeRef = useRef(onStatusChange);
  onSessionIdRef.current = onSessionId;
  onStatusChangeRef.current = onStatusChange;

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: '"IBM Plex Mono", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 10000,
      convertEol: true,
      disableStdin: true, // Read-only terminal
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    // Use WebGL renderer for proper character positioning (no span gaps)
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch (e) {
      console.warn('[XTerminal] WebGL not available, using DOM renderer:', e);
    }

    // Fit terminal to container
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    // Use ResizeObserver for container size changes
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Write initial content when terminal is ready
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialContent) return;

    terminal.write(initialContent);
  }, [initialContent]);

  // Connect to WebSocket for live updates
  useEffect(() => {
    if (!isLive) return;

    const terminal = terminalRef.current;
    if (!terminal) return;

    // Build WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/terminal?taskId=${taskId}${token ? `&token=${encodeURIComponent(token)}` : ''}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log(`[XTerminal] WebSocket connected for task ${taskId}`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'output':
            terminal.write(msg.data);
            break;
          case 'session':
            onSessionIdRef.current?.(msg.sessionId);
            break;
          case 'end':
            onStatusChangeRef.current?.(msg.status === 'completed' ? 'completed' : 'failed');
            break;
          case 'error':
            terminal.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
            onStatusChangeRef.current?.('failed');
            break;
        }
      } catch (err) {
        console.error('[XTerminal] Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('[XTerminal] WebSocket error:', err);
    };

    ws.onclose = () => {
      console.log(`[XTerminal] WebSocket closed for task ${taskId}`);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [taskId, token, isLive]);

  // Auto-scroll on new content
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const disposable = terminal.onWriteParsed(() => {
      terminal.scrollToBottom();
    });

    return () => {
      disposable.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="xterminal-container"
      style={{
        width: '100%',
        height: '100%',
        minHeight: '400px',
        backgroundColor: TERMINAL_THEME.background,
      }}
    />
  );
}
