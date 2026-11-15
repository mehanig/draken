import type { ConversationState } from '../types';

export function ConversationInfo({ state, unavailable = false }: { state?: ConversationState; unavailable?: boolean }) {
  if (!state && !unavailable) return null;
  const label = state?.ended_at ? 'Session ended' : unavailable ? 'Update status unavailable' : state ? {
    up_to_date: 'Up to date', preparing: 'Preparing new info…', new_info: 'New info ready',
    paused: 'Live updates paused', error: 'Updates unavailable',
  }[state.update_state] : 'Update status unavailable';
  const detail = state?.ended_at ? 'This session has ended. Its transcript is retained and nothing was marked reviewed automatically.'
    : state?.error || 'Keep chatting with the last prepared context. Newly prepared information is adopted between turns; previous messages and the initial briefing stay unchanged.';
  return <span className="small muted conversation-info" role="status" aria-label="Conversation updates" title={detail}>
    <span aria-hidden="true">{state?.update_state === 'preparing' ? '◌' : '●'}</span> {label}
  </span>;
}
