import type Database from 'better-sqlite3';
import type { HistoryQuery } from './types';
import { statusQuestion } from './reconcile';

export interface HistoryFocus { sessions: string[]; question: string; topics?: string[] }
const common = new Set('hello hi hey can could would please check tell about what whats happening going latest current now doing working work trying achieve project repo repository called have with from this that those these here there where which when your our app application ios native rewrite version status update progress mean meant exactly does how the and for are was were has had you it its into written make want thinking using upload uploading safety missing links visual parity screens screen functional original remains tests testing tested implementation implemented images photos profile navigation blocked blocker blockers unfinished unconfirmed remaining finished completed completion left long longer'.split(' '));
const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])].filter(word => word.length >= 3 && !common.has(word));
const conversationQuestion = (question: string) => /\b(?:what (?:did|have) (?:i|we|you) (?:ask|say|discuss|agree|decide)|(?:previous|earlier|last) (?:call|conversation|discussion)|remember (?:when|what)|quote (?:me|our))\b/i.test(question);

/** Shared text/voice continuity. Only actual saved user turns establish focus;
 * generated replies, briefings and quoted source instructions never select it.
 * Re-resolve against current source permissions when a new call is reserved. */
export function discussionFocus(db: Database.Database, syncId: number, currentUserId = -1): HistoryFocus | undefined {
  const users = db.prepare(`SELECT content FROM (
    SELECT content,created_at AS at FROM sync_messages WHERE sync_id=? AND role='user' AND id!=?
    UNION ALL SELECT m.text AS content,m.started_at AS at FROM live_messages m JOIN live_calls c ON c.id=m.call_id
      WHERE c.sync_id=? AND m.role='user' AND m.status='generated'
  ) ORDER BY at DESC LIMIT 30`).all(syncId, currentUserId, syncId) as { content: string }[];
  let focus: HistoryFocus | undefined;
  for (const turn of users.reverse()) focus = historyQuery(db, turn.content, focus).focus;
  return focus;
}

/** Resolve scope from admitted session metadata and the actual user's turns,
 * never from commands or project names embedded in retrieved source text. */
export function historyQuery(db: Database.Database, question: string, previous?: HistoryFocus): { focus: HistoryFocus; query: HistoryQuery } {
  const terms = words(question);
  const rows = db.prepare(`SELECT s.id,s.name,s.cwd FROM agent_sessions s JOIN agent_sources a ON a.id=s.agent
    WHERE s.included=1 AND s.missing=0 AND a.enabled=1 ORDER BY s.id`).all() as { id: string; name: string; cwd: string }[];
  const named = rows.map(row => ({ id: row.id, words: words(`${row.name} ${row.cwd.split(/[\\/]/).pop() || ''}`) }));
  // Common workspace names cannot select a project shared by every session.
  const matches = terms.map(word => ({ word, sessions: named.filter(row => row.words.includes(word)).map(row => row.id) }))
    .filter(item => item.sessions.length > 0 && item.sessions.length <= 8 && (item.sessions.length < rows.length || rows.length === 1))
    .sort((a, b) => a.sessions.length - b.sessions.length || b.word.length - a.word.length);
  const selectedSessions = [...new Set(matches.flatMap(match => match.sessions))];
  const explicit = selectedSessions.length && selectedSessions.length <= 8 ? selectedSessions : undefined;
  const switching = /\b(?:switch|different project|another project|instead)\b/i.test(question);
  const sessions = explicit || (switching ? [] : previous?.sessions || []);
  const same = previous && JSON.stringify(previous.sessions) === JSON.stringify(sessions);
  const recall = conversationQuestion(question);
  const recent = !recall && (statusQuestion(question) || /\b(?:happening|at the moment|working on|trying to achieve|have you checked|visual parity|screens match|what changed)\b/i.test(question));
  // The preceding question supplies the referent for "those" / "uploading here".
  // Session scope is independent of this text, so a follow-up cannot drift into
  // an unrelated project merely because its wording is generic.
  const explained = question.match(/\b(?:mean|meant by|explain)\s+([^?.]{3,160})/i)?.[1];
  const followup = /\b(?:here|those|that|have you checked|screens match|what remains)\b/i.test(question);
  const queryText = same && !explicit && followup && !explained ? `${question}\nPrevious question in this conversation: ${previous.question}` : question;
  const namedTopics = explained?.split(/\s+(?:and|versus|vs\.?)\s+/i).map(value => value.trim()).filter(Boolean).slice(0, 2);
  const topics = namedTopics || (same && /\b(?:here|those|that|exactly)\b/i.test(question) ? previous?.topics : undefined);
  return { focus: { sessions, question: question.slice(0, 2000), topics }, query: {
    question: queryText.slice(0, 2000), ...(sessions.length && !recall ? { session_ids: sessions } : {}),
    kind: recall ? 'conversation' : 'sources', recent, ...(topics && !recall ? { topics } : {}),
  } };
}
