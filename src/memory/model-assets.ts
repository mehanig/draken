import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { MODEL, REVISION, FILES } from './model-files';
import { historyUpdate, type ReportHistory } from './types';

// Presence is a cheap readiness hint; inference still verifies the actual bytes.
export function modelFilesPresent(directory: string): boolean {
  return FILES.every(file => { try { return fs.statSync(path.join(directory, file.name)).size === file.size; } catch { return false; } });
}

async function verified(directory: string, file: typeof FILES[number]): Promise<boolean> {
  const hash = createHash('sha256');
  try { for await (const chunk of fs.createReadStream(path.join(directory, file.name))) hash.update(chunk); return hash.digest('hex') === file.sha; }
  catch { return false; }
}

export async function verifyModelFiles(directory: string): Promise<void> {
  for (const file of FILES) if (!await verified(directory, file)) throw new Error('Pinned embedding files are missing or damaged. Retry the history request to repair them.');
}

export async function prepareModelFiles(directory: string, report?: ReportHistory, allowDownload = true): Promise<void> {
  const total = FILES.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  for (const file of FILES) {
    if (await verified(directory, file)) { completed += file.size; continue; }
    if (!allowDownload) throw new Error('Pinned embedding files are missing or damaged. Prepare history before calling.');
    const progress = (size: number) => report?.(historyUpdate('downloading', { downloaded_bytes: completed + size, download_total_bytes: total }));
    progress(0);
    const target = path.join(directory, file.name), temporary = target + '.part';
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${file.name}`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('Model download failed');
      const handle = fs.openSync(temporary, 'w', 0o600), hash = createHash('sha256'); let size = 0;
      try {
        for await (const chunk of response.body) {
          size += chunk.length; if (size > file.size) throw new Error('Model size mismatch');
          hash.update(chunk); fs.writeSync(handle, chunk); progress(size);
        }
      } finally { fs.closeSync(handle); }
      if (size !== file.size || hash.digest('hex') !== file.sha) throw new Error('Model checksum mismatch');
      fs.renameSync(temporary, target); completed += file.size;
    } finally { clearTimeout(timer); fs.rmSync(temporary, { force: true }); }
  }
}
