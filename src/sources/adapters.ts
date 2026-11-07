import type { AgentKind } from '../types';
import type { PointerRecord } from '../sync/jsonl';
import { cleanText, digest, normalizeEntry, type NormalizedEntry, type NormalizationVersion } from '../sync/normalize';
import { sessionId, type SourceIdentity } from './registry';

export interface SourceHeader extends SourceIdentity { id: string; cwd: string }
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
/** Bounded header/identity discovery. Never read credentials, history.jsonl,
 * request dumps or tool definitions as session headers. */
export function identifySource(agent: AgentKind, records: Iterable<PointerRecord>): SourceHeader {
  let count = 0;
  for (const { value: r } of records) {
    if (++count > 256) break;
    if (!r || typeof r !== 'object') continue;
    if (agent === 'pi') {
      if (r.type === 'session' && r.version !== 3) throw new Error('Unsupported pi session version; only v3 JSONL is supported');
      if (r.type !== 'session' || typeof r.id !== 'string' || typeof r.cwd !== 'string') break;
      return { agent, external_id: r.id, parser_version: 1, id: r.id, cwd: r.cwd };
    }
    if (agent === 'codex') {
      const p = r.payload;
      if (r.type !== 'session_meta' || !identifier(p?.id) || typeof p.cwd !== 'string') break;
      if (p.history_base) throw new Error('Codex external history-base rollouts are not supported; no inherited evidence was guessed');
      const source = { agent, external_id: p.id, parser_version: 1 as const };
      return { ...source, id: sessionId(source), cwd: p.cwd };
    }
    if (identifier(r.sessionId) && identifier(r.uuid) && typeof r.cwd === 'string') {
      // Subagent files often share their parent's sessionId. A recorded agent ID
      // (or the first sidechain message UUID) separates them without relying on a filename.
      const suffix = r.isSidechain === true ? (identifier(r.agentId) ? r.agentId : r.uuid) : undefined;
      const source = { agent, external_id: r.sessionId + (suffix ? '/' + suffix : ''), parser_version: 1 as const };
      return { ...source, id: sessionId(source), cwd: r.cwd };
    }
  }
  throw new Error(`No supported ${agent} session header/identity found`);
}
function textBlocks(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(part => part && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}
function tool(name: unknown, args: unknown) {
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  return { type: 'toolCall', name: typeof name === 'string' ? name.slice(0, 100) : 'unknown', arguments: args && typeof args === 'object' ? args : {} };
}
const contextOnly = (text: string) => /^(?:# AGENTS\.md instructions for [^\n]*\n\s*)?<(environment_context|INSTRUCTIONS|permissions instructions)>[\s\S]*<\/\1>\s*$/.test(text.trim());

/** v1 adapter recipes are immutable: live and frozen pointers use the same
 * normalizer. One physical record projects to at most one evidence entry. */
export function normalizeSource(source: SourceIdentity, record: PointerRecord, version: NormalizationVersion = 2): NormalizedEntry | null {
  if (source.parser_version !== 1) throw new Error('Unknown agent parser version');
  if (source.agent === 'pi') return normalizeEntry(record.value, version);
  const r = record.value;
  if (!r || typeof r !== 'object') return null;
  let value: any;
  if (source.agent === 'codex') {
    const p = r.payload;
    if (r.type === 'event_msg' && p?.type === 'thread_rolled_back') throw new Error('Codex rollback replay is not supported; scan stopped rather than treating abandoned turns as current');
    const id = `record-${record.record_offset}`, timestamp = typeof r.timestamp === 'string' ? r.timestamp : '';
    if (r.type === 'response_item' && p && typeof p === 'object') {
      let role = '', content: unknown = '';
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role) && p.channel !== 'analysis') {
        role = p.role; const text = textBlocks(p.content); content = role === 'user' && contextOnly(text) ? '' : text;
      } else if (p.type === 'function_call') { role = 'assistant'; content = [tool(p.name, p.arguments)]; }
      else if (p.type === 'custom_tool_call') { role = 'assistant'; content = [tool(p.name, {})]; }
      else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        role = 'toolResult'; content = textBlocks(p.output);
      } else if (p.type === 'local_shell_call') { role = 'assistant'; content = [tool('shell', { command: Array.isArray(p.action?.command) ? p.action.command.filter((part: unknown) => typeof part === 'string').join(' ') : '' })]; }
      if (role) value = { id, timestamp, type: 'message', message: { role, content, toolName: 'Codex tool output; success not inferred', stopReason: p.status === 'incomplete' ? 'length' : undefined } };
    } else if (r.type === 'compacted' && typeof p?.message === 'string') value = { id, timestamp, type: 'compaction', summary: p.message };
    else if (r.type === 'event_msg' && p?.type === 'turn_aborted') value = { id, timestamp, type: 'custom_message', content: '[Codex turn aborted. Earlier generated text does not establish completed work.]' };
    // event_msg user_message/agent_message echo response_item messages; never
    // import both. Reasoning, token counts, request context and system/developer messages are not evidence.
  } else {
    if (!identifier(r.uuid)) return null;
    if (r.sessionId !== undefined && r.sessionId !== source.external_id.split('/')[0]) throw new Error('Mixed Claude session identities; scan stopped rather than guessing fork attribution');
    const parentId = typeof r.parentUuid === 'string' ? r.parentUuid : typeof r.logicalParentUuid === 'string' ? r.logicalParentUuid : null;
    if (r.type === 'system' && r.subtype === 'compact_boundary' && !parentId) throw new Error('Claude compaction boundary has no verified history link');
    value = { id: r.uuid, parentId, timestamp: typeof r.timestamp === 'string' ? r.timestamp : '', type: String(r.type || 'metadata') };
    if (['user', 'assistant'].includes(r.type) && r.message) {
      if (r.isCompactSummary === true) { value.type = 'compaction'; value.summary = textBlocks(r.message.content); }
      else if (r.isMeta !== true) {
        if (typeof r.message.role === 'string' && r.message.role !== r.type) throw new Error('Claude role attribution mismatch');
        const parts = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : Array.isArray(r.message.content) ? r.message.content : [];
        const blocks: any[] = []; let results = 0, ordinary = 0;
        for (const part of parts) {
          if (part?.type === 'text' && typeof part.text === 'string') { blocks.push(part); ordinary++; }
          else if (part?.type === 'tool_use') { blocks.push(tool(part.name, part.input)); ordinary++; }
          else if (part?.type === 'tool_result') { blocks.push({ type: 'text', text: `Tool result (${cleanText(String(part.tool_use_id || 'unknown'), 150)}; ${part.is_error === true ? 'error' : 'not flagged as error'}):\n${textBlocks(part.content)}` }); results++; }
        }
        value.type = 'message'; value.message = { role: results && !ordinary ? 'toolResult' : r.type, content: blocks, toolName: 'Claude tool output', stopReason: ['max_tokens', 'model_context_window_exceeded'].includes(r.message.stop_reason) ? 'length' : undefined };
      }
    }
  }
  if (!value) return null;
  const entry = normalizeEntry(value, version); if (!entry) return null;
  // Agent domains prevent identical pi/Claude UUIDs from sharing review coverage.
  entry.event_key = digest(JSON.stringify([source.agent, 1, source.agent === 'codex' ? record.record_hash : entry.event_key, entry.type, entry.role, entry.text]));
  return entry;
}
