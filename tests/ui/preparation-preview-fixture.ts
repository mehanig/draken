import type { Request } from '@playwright/test';

// Home may request the metadata-only local check. All other writes (including
// any different method/body on this endpoint) remain mutations in consent tests.
export function isFreePreviewRequest(request: Request): boolean {
  return new URL(request.url()).pathname === '/api/preparation-preview'
    && request.method() === 'POST' && request.postData() === '{}';
}
