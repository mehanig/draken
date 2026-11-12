import type { Evidence, SyncDetail } from '../types';

export function retrieveEvidence(sync: Pick<SyncDetail, 'items' | 'context'>, question: string): Evidence[] {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}_/-]{3,}/gu) || [])].slice(0, 40);
  const explicit = new Set(question.match(/\b[EC]\d+\b/g) || []);
  return [...sync.items, ...sync.context].map(item => ({ item,
    score: (explicit.has(item.ref) ? 1000 : 0) + words.reduce((sum, word) => sum + Number(`${item.cwd} ${item.text}`.toLowerCase().includes(word)), 0),
  })).filter(row => row.score > 0).sort((a, b) => b.score - a.score || b.item.timestamp.localeCompare(a.item.timestamp))
    .slice(0, 16).map(row => row.item);
}
