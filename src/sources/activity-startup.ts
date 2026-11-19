import type Database from 'better-sqlite3';
import { createInterface } from 'node:readline/promises';
import { activityWindowStatus, validActivityDays } from './activity-window';

export function parseHistoryDays(value: string): number | null {
  const days = value === 'all' ? null : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!validActivityDays(days)) throw new Error('--history-days must be 1–36500 or all');
  return days;
}

/** Called only after the server has bound its ports and owns the data directory. */
export async function configureStartupWindow(db: Database.Database, days: number | null, yes = false): Promise<void> {
  const preview = activityWindowStatus(db, days);
  if (preview.confirmation_required && !yes) {
    if (!process.stdin.isTTY) throw new Error('Widening history may use provider quota or API billing. Run interactively to confirm, or pass --yes.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`Change the history window to ${days === null ? 'all history' : `${days} days`}? This adds ${preview.additional_sessions} recorded sessions; later scans may find more. Automatic preparation may use provider quota or API billing. [y/N] `);
      if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Startup cancelled. The activity window was not changed.');
    } finally { prompt.close(); }
  }
  db.prepare("INSERT INTO sync_settings(key,value) VALUES('activity_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(days));
}
