import type { SyncCost as Cost } from '../../../src/types';

export function SyncCost({ cost }: { cost?: Cost | null }) {
  if (!cost) return null;
  const amount = cost.usd === null ? 'unavailable' : cost.usd > 0 && cost.usd < 0.000001 ? '<$0.000001'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: cost.usd < 0.01 ? 6 : 2 }).format(cost.usd);
  const explanation = 'Sync preparation only: summaries, consolidation, preparation recaps and final briefing, including retries. Excludes later questions, calls and conversation recaps. API-equivalent estimate from pi usage and catalog prices, not a subscription charge or invoice.';
  const qualification = cost.usd === null ? ' Usage/pricing was not captured or is unavailable for this preparation.' : !cost.complete ? ' Partial total: some preparation usage/pricing is missing or work is still running.' : '';
  return <span className="sync-cost small muted" title={explanation + qualification}>Est. cost: {amount}{cost.usd !== null && !cost.complete ? ' (partial)' : ''}</span>;
}
