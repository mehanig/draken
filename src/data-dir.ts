import path from 'path';
import os from 'os';

export function getDataDir(): string {
  return path.resolve(process.env.DRAKEN_DATA_DIR || path.join(os.homedir(), '.draken'));
}
