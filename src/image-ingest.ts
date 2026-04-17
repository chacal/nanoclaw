import fs from 'fs';
import path from 'path';

import { cleanupOldImages, getGroupImagesDir } from './group-folder.js';
import { logger } from './logger.js';

/**
 * Save an inbound image into a group's images/ directory and return the
 * `[Image: images/...]` marker the agent-runner expects. Also prunes stale
 * images on the way out (best-effort).
 *
 * `channelPrefix` disambiguates filenames across channels (e.g. "tg", "sig").
 * `id` should be a channel-unique identifier such as a Telegram message id or
 * Signal attachment id.
 */
export function ingestImage(
  data: Buffer,
  channelPrefix: string,
  id: string,
  ext: string,
  groupFolder: string,
): string | null {
  try {
    const imagesDir = getGroupImagesDir(groupFolder);
    const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
    const filename = `${channelPrefix}-${id}${safeExt}`;
    fs.writeFileSync(path.join(imagesDir, filename), data);
    cleanupOldImages(imagesDir);
    return `[Image: images/${filename}]`;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Failed to ingest image');
    return null;
  }
}
