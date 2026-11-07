import { createHash } from 'crypto';
import type { Evidence } from '../types';

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

// Stable across sync-local E/C references, but changes when a context edit changes the excerpt.
export function sourceKey(item: Evidence): string {
  if (item.unavailable && /^K[a-f0-9]{20}$/.test(item.source_key || '')) return item.source_key!;
  return `K${digest(JSON.stringify([item.event_key, item.text])).slice(0, 20)}`;
}

export type NormalizationVersion = 1 | 2;
/** Version 1 is read-only compatibility for existing evidence, never new imports.
 * Keep these recipes stable: pointers must reconstruct exactly their old view.
 * Best-effort minimization, NOT a guarantee of secret-free text. */
export function cleanText(value: string, limit = 6000, version: NormalizationVersion = 2): string {
  if (version !== 1 && version !== 2) throw new Error('Unknown evidence normalization version');
  let clean = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[token redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
  if (version === 2) clean = clean.replace(/(\b(?:password|api[_-]?key|access[_-]?token|secret)\b(?:\*\*|__)?\s*[:=](?:\*\*|__)?\s*`)[^`\r\n]{6,}(`)/gi, '$1[redacted]$2');
  clean = clean.replace(/(\b(?:[a-z0-9]+_)*(?:authorization|api[_-]?key|access[_-]?token|password|secret|secret_access_key)\b["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return clean.length > limit ? `${clean.slice(0, limit)}\n[excerpt truncated]` : clean;
}

function contentText(content: unknown, version: NormalizationVersion): string {
  if (typeof content === 'string') return cleanText(content, 6000, version);
  if (!Array.isArray(content)) return '';
  const blocks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') blocks.push(block.text);
    if (block.type === 'toolCall') {
      // Capture intent/paths, not write-file contents or arbitrary tool payloads.
      const args = block.arguments || {};
      const selected: Record<string, unknown> = {};
      for (const key of ['path', 'file_path', 'command', 'pattern', 'query', 'description']) {
        if (typeof args[key] === 'string') selected[key] = cleanText(args[key], 1200, version);
      }
      blocks.push(`Tool requested: ${String(block.name)} ${JSON.stringify(selected)}`);
    }
    // Never index thinking, signatures, image/audio data, or system instructions.
  }
  return cleanText(blocks.join('\n'), 6000, version);
}

export interface NormalizedEntry {
  entry_id: string;
  parent_id: string | null;
  timestamp: string;
  type: string;
  role: string;
  text: string;
  event_key: string;
  is_activity: number;
  target_id: string | null;
  replacement: string | null;
}

export function normalizeEntry(entry: any, version: NormalizationVersion = 2): NormalizedEntry | null {
  if (!entry || typeof entry.id !== 'string' || typeof entry.type !== 'string') return null;
  const type = entry.type;
  let role = type;
  let text = '';
  let isActivity = false;
  if (type === 'message' && entry.message) {
    const message = entry.message;
    role = String(message.role || 'unknown');
    if (['user', 'assistant', 'toolResult', 'custom'].includes(role)) {
      text = contentText(message.content, version);
      if (role === 'toolResult' && text) {
        text = `Tool result (${String(message.toolName || 'unknown')}; ${message.isError ? 'error' : 'not flagged as error'}):\n${text}`;
      }
      if (role === 'assistant' && ['error', 'aborted', 'length'].includes(message.stopReason)) {
        text += `\n[Assistant stop reason: ${message.stopReason}]`;
      }
    } else if (role === 'bashExecution' && !message.excludeFromContext) {
      text = cleanText(`Command: ${message.command || ''}\nExit code: ${message.exitCode ?? 'unknown'}\n${message.output || ''}`, 6000, version);
    }
    isActivity = Boolean(text);
  } else if (type === 'custom_message') {
    text = contentText(entry.content, version);
    isActivity = Boolean(text);
  } else if (type === 'compaction' || type === 'branch_summary') {
    text = cleanText(typeof entry.summary === 'string' ? entry.summary : '', 6000, version);
    // Summaries are background, never new accomplishments.
  }
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
  const parentId = typeof entry.parentId === 'string' ? entry.parentId : null;
  return {
    entry_id: entry.id,
    parent_id: parentId,
    timestamp,
    type,
    role,
    text: cleanText(text, 6000, version),
    // Forks copy entries. Identity across sessions prevents re-briefing inherited history.
    event_key: digest(JSON.stringify([entry.id, parentId, timestamp, type, role, text])),
    is_activity: Number(isActivity),
    target_id: type === 'context_edit' && typeof entry.targetId === 'string' ? entry.targetId : null,
    replacement: type === 'context_edit' && entry.replacement !== null ? contentText(entry.replacement, version) : null,
  };
}
