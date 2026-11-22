import { HttpError } from '../errors';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

const DEFAULT_ACTIVITY_DAYS = 7;
export function activityDays(db: Database.Database): number | null {
  const row = db.prepare("SELECT value FROM sync_settings WHERE key='activity_days'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as number | null : DEFAULT_ACTIVITY_DAYS;
}
export function validActivityDays(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 36500);
}
export function withinActivityWindow(lastMessage: string | null, days: number | null, now = Date.now()): boolean {
  return days === null || Boolean(lastMessage && Date.parse(lastMessage) >= now - days * 86400000);
}
/** Session-level filter: an eligible session keeps its older messages too. */
export function recentSession(alias: string): string {
  const days = `COALESCE((SELECT value FROM sync_settings WHERE key='activity_days'), '${DEFAULT_ACTIVITY_DAYS}')`;
  return `(${days}='null' OR julianday(${alias}.last_message_at)>=julianday('now')-CAST(${days} AS INTEGER))`;
}
export function assertRecentSessions(db: Database.Database, sessions: Iterable<string>): void {
  if (activityDays(db) === null) return;
  const ids = [...new Set(sessions)];
  const eligible = db.prepare(`SELECT COUNT(*) n FROM agent_sessions s WHERE s.id IN (SELECT value FROM json_each(?)) AND ${recentSession('s')}`).get(JSON.stringify(ids)) as { n: number };
  if (eligible.n !== ids.length) throw new HttpError(409, 'Some sessions are outside the activity window. Change the window in Settings before preparing this snapshot. Saved history and cached work are retained.');
}
export function activityWindowStatus(db: Database.Database, proposed = activityDays(db)) {
  const current = activityDays(db), now = Date.now();
  const widens = current !== null && (proposed === null || proposed > current);
  if (!widens) return { days: current, proposed_days: proposed, additional_sessions: 0, confirmation_required: false, confirmation: '' };
  const sessions = db.prepare(`SELECT s.id,s.last_message_at FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent
    WHERE s.included=1 AND s.missing=0 AND a.enabled=1 ORDER BY s.id`).all() as { id: string; last_message_at: string | null }[];
  const added = sessions.filter(s => withinActivityWindow(s.last_message_at, proposed, now) && !withinActivityWindow(s.last_message_at, current, now)).length;
  const confirmation = createHash('sha256').update(JSON.stringify([current, proposed, sessions])).digest('hex');
  return { days: current, proposed_days: proposed, additional_sessions: added, confirmation_required: widens, confirmation };
}
