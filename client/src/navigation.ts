import type { MouseEvent } from 'react';

export type Navigate = (path: string, call?: boolean) => void;
export function linkClick(event: MouseEvent<HTMLAnchorElement>, navigate: Navigate, path: string): void {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(path);
}
