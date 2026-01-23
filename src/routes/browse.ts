import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DirectoryEntry } from '../types';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const requestedPath = (req.query.path as string) || os.homedir();

  try {
    // Resolve to absolute path
    const absolutePath = path.resolve(requestedPath);

    // Check if path exists and is a directory
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Path not found' });
    }

    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    // Read directory contents
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true });

    const directories: DirectoryEntry[] = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: path.join(absolutePath, entry.name),
        isDirectory: true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Get parent directory
    const parentPath = path.dirname(absolutePath);
    const hasParent = parentPath !== absolutePath;

    res.json({
      currentPath: absolutePath,
      parentPath: hasParent ? parentPath : null,
      entries: directories,
    });
  } catch (err) {
    console.error('Browse error:', err);
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

export default router;
