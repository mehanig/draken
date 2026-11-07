import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { LocalEmbedder } from './model';

// No database, source-file discovery, download or provider credentials. The
// owning history process verifies/downloads weights; this lane only reads them.
if (!parentPort || !path.isAbsolute(workerData?.directory || '')) throw new Error('Invalid embedding lane');
const model = new LocalEmbedder(workerData.directory, workerData.threads);
let busy = false;
parentPort.on('message', async (message: any) => {
  if (busy || !Number.isSafeInteger(message?.id) || typeof message.text !== 'string' || message.text.length > 16000 || typeof message.query !== 'boolean') {
    parentPort!.postMessage({ id: message?.id, error: true }); return;
  }
  busy = true;
  try {
    const vector = await model.embed(message.text, message.query);
    parentPort!.postMessage({ id: message.id, vector: vector.buffer }, [vector.buffer as ArrayBuffer]);
  } catch { parentPort!.postMessage({ id: message.id, error: true }); }
  finally { busy = false; }
});
