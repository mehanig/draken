import { randomUUID } from 'node:crypto';
import { getDb } from '../db/schema';
import { prepareHistory } from '../memory/service';
import { generateReply } from './manager';
import { assertAutomaticScope, automaticSyncId, availableCount, startConversationSync } from './store';
import { activity } from './activity';

export function pendingAutomaticBriefing(): number | undefined {
  const row = getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_preparing_sync'").get() as { value: string } | undefined;
  const id = row ? Number(row.value) : undefined;
  return id !== undefined && (automaticSyncId(false) === id || automaticSyncId(true) === id) ? id : automaticSyncId(false);
}

/** A failed provider run needs an explicit retry, not an endless paid timer loop.
 * Interrupted/cancelled runs may resume from their durable cached tree. */
export function automaticBriefingError(): string {
  const row = getDb().prepare("SELECT value FROM sync_settings WHERE key='auto_briefing_failed'").get() as { value: string } | undefined;
  if (!row) return '';
  const pending = pendingAutomaticBriefing();
  return pending === Number(row.value) ? `Automatic briefing #${pending} stopped. Open that sync to inspect or retry it, or retry automatic preparation. Completed summaries are retained.` : '';
}
export function retryAutomaticBriefing(): void {
  getDb().prepare("DELETE FROM sync_settings WHERE key='auto_briefing_failed'").run();
}
export async function prepareAutomaticBriefing(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const pending = pendingAutomaticBriefing();
  if (pending === undefined && !availableCount()) return;
  const id = pending ?? startConversationSync(`auto:${randomUUID()}`, true).id;
  getDb().prepare("INSERT INTO sync_settings(key,value) VALUES ('auto_preparing_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
  const release = activity.beginBackground(id);
  try {
    assertAutomaticScope(id);
    await generateReply(id, undefined, undefined, { signal, deferHistory: true });
    signal.throwIfAborted();
    // Include the completed preparation's retained context in the readiness
    // receipt, outside a conversation and with the same cancellation owner.
    await prepareHistory(new Date().toISOString(), signal, true);
    signal.throwIfAborted();
    getDb().prepare("DELETE FROM sync_settings WHERE key='auto_preparing_sync' AND value=?").run(String(id));
  } catch (error) {
    if (!signal.aborted) getDb().prepare("INSERT INTO sync_settings(key,value) VALUES ('auto_briefing_failed',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
    throw error;
  } finally { release(); }
}
