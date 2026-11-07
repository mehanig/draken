import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import type { AgentKind, AgentSource } from '../types';

export type SourceRoots = Record<AgentKind, string[]>;
export type RootInput = string | SourceRoots;
export interface SourceIdentity { agent: AgentKind; external_id: string; parser_version: 1 }
export const AGENTS: AgentKind[] = ['pi', 'codex', 'claude'];
export function getSourceRoots(): SourceRoots {
  const home = os.homedir(), codex = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));
  return {
    pi: [path.resolve(process.env.DRAKEN_PI_SESSIONS_DIR || path.join(home, '.pi/agent/sessions'))],
    codex: process.env.DRAKEN_CODEX_SESSIONS_DIR ? [path.resolve(process.env.DRAKEN_CODEX_SESSIONS_DIR)] : [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions')],
    claude: [path.resolve(process.env.DRAKEN_CLAUDE_SESSIONS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects'))],
  };
}
export function sourceRoots(value: RootInput = getSourceRoots()): SourceRoots {
  // An explicit legacy/test root grants access only to that pi directory.
  if (typeof value === 'string') return { pi: [path.resolve(value)], codex: [], claude: [] };
  if (!value || AGENTS.some(agent => !Array.isArray(value[agent]) || value[agent].some(root => typeof root !== 'string' || !path.isAbsolute(root)))) throw new Error('Invalid agent source roots');
  return value;
}
export function validIdentity(value: SourceIdentity): boolean {
  return Boolean(value && AGENTS.includes(value.agent) && value.parser_version === 1 && typeof value.external_id === 'string' && /^[\w-]{1,128}(?:\/[\w-]{1,128})?$/.test(value.external_id));
}
export function sessionId(source: SourceIdentity): string {
  if (source.agent === 'pi') return source.external_id;
  if (!validIdentity(source)) throw new Error('Invalid agent session identity');
  return `${source.agent}:${source.external_id.replace('/', ':')}`;
}
export const admittedAgent = (alias: string) => `${alias}.agent IN (SELECT id FROM agent_sources WHERE enabled=1)`;
export function agentSources(db: Database.Database): AgentSource[] {
  const roots = getSourceRoots(), names = { pi: 'pi', codex: 'Codex CLI', claude: 'Claude Code' };
  return AGENTS.map(id => ({ id, name: names[id], enabled: Boolean((db.prepare('SELECT enabled FROM agent_sources WHERE id=?').get(id) as any)?.enabled),
    roots: roots[id].map(root => { try { return { path: root, status: fs.statSync(root).isDirectory() ? 'present' as const : 'unavailable' as const }; }
      catch (error) { return { path: root, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unavailable' as const }; } }) }));
}
