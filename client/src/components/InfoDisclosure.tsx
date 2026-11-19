import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import './InfoDisclosure.css';

/** Native disclosure: closed by default, usable with touch and keyboard. */
export function InfoDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className="info-disclosure" onKeyDown={event => {
    if (event.key === 'Escape' && event.currentTarget.open) {
      event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
      event.currentTarget.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-label={label} title={label}><Info size={20} aria-hidden="true" /></summary>
    <div className="info-content">{children}</div>
  </details>;
}
